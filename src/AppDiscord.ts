import { Discord, On, Client, CommandMessage, Guard } from '@typeit/discord';
import 'reflect-metadata';
import config from './configs/config.json';
import activities from './configs/activities.json';
import { Command } from './ArgumentParser';
import { Owner } from './guards/Owner';
import { HelpEmbedBrowser } from './embed-browsers/HelpEmbedBrowser';
import { RegexUtils } from './utils/RegexUtils';
import { MessageEmbed } from 'discord.js';
import { IOnExt } from './types/IOnExt';
import { GIT_HASH, PACKAGE_VERSION, TYPESCRIPT_VERSION } from './constants';
import { RandomUtils } from './utils/RandomUtils';
import { MathUtils } from './utils/MathUtils';
import { BaseActivity } from './activities/BaseActivity';
import moment from 'moment';
import { findBestMatch } from 'string-similarity';
import { ServerHandler } from './workers/ServerHandler';

@Discord({
    prefix: config.prefix
})
export abstract class AppDiscord {
    private static _client: Client;

    private static last_activity: BaseActivity;
    private static last_timeout: NodeJS.Timer;

    private static activity_randomizer = RandomUtils.create_randomizer<{ new(client: Client): BaseActivity }>(activities.map(activity =>
        require(`./activities/${activity}`)[activity]
    ));

    private start_time: moment.Moment;

    public static start() {
        this._client = new Client();
        this._client.login(config.token,
            `${__dirname}/commands/*.js`,
            `${__dirname}/commands/image-macros/*.js`,
            `${__dirname}/commands/search-embeds/*.js`,
            `${__dirname}/embed-browsers/BaseEmbedBrowser.js`
        );

        ServerHandler.set_cache_dir(`${__dirname}/${config.cache_dir}/`);
    }

    @On('ready')
    private ready(client: Client) {
        AppDiscord.process_next_activity();
        this.start_time = moment();
        ServerHandler.set_client_id(client.user.id);
    }

    public static async destroy() {
        await this.last_activity.destroy();
        this._client.destroy();
    }

    private static async process_next_activity() {
        const client = this._client;
        client.clearTimeout(this.last_timeout);

        if (this.last_activity) await this.last_activity.destroy();

        await client.user.setPresence({
            status: 'online'
        });

        const constructor = this.activity_randomizer();

        const activity = new constructor(client);
        activity.create();

        AppDiscord.last_activity = activity;

        const next_delay = MathUtils.clamp(RandomUtils.gaussian(1, 10), .5, Infinity);
        this.last_timeout = client.setTimeout(() => this.process_next_activity(), next_delay * 60e3);
    }

    @Command('ping', {
        infos: 'Round-trip ping',
        extraneous_argument_message: false
    })
    private async ping(message: CommandMessage, client: Client) {
        const reply = await message.channel.send(`Calculating ping...`);
        reply.edit(`:ping_pong: Pong! ~${(reply.createdTimestamp - message.createdTimestamp).toFixed(2)}ms RTT, ~${client.ws.ping.toFixed(2)}ms WS`);
    }

    @Command('h', {
        infos: 'Get help',
        description: `Gets help (use \`${config.prefix}h [command]\` for command details`,
        extraneous_argument_message: false,
        aliases: ['help']
    })
    private async help(message: CommandMessage, command: string = null) {
        if (!command) return new HelpEmbedBrowser().send_embed(message);
        
        const commands = Client.getCommandsIntrospection() as IOnExt[];
        command = command.trim().replace(new RegExp(`^${RegexUtils.escape(config.prefix)}`, 'i'), '');
        const command_obj = commands.find(({ commandName, aliases }) => commandName == command || aliases?.includes(command));
        
        if (!command_obj || command_obj.hide) {
            let { ratings } = findBestMatch(command, commands.filter(command => !command.hide).flatMap(command => [command.commandName, ...(command.aliases ?? [])]));
            ratings = ratings.filter(({ rating }) => rating > .66).map(({ target }) => target);

            if (!ratings.length) return message.reply(`Error: command \`${command}\` not found`);

            const embed = new MessageEmbed({ title: `Command \`${command}\` not found` });
            embed.addField('Did you mean the following?', ratings.map(name => {
                const command_obj = commands.find(({ commandName, aliases }) => commandName == name || aliases?.includes(name));
                if (!command_obj) return '';

                return `\`${command_obj.commandName}\`, from ${command_obj.group}: ${command_obj.infos ?? ''}`;
            }).filter(x => x).join('\n'))

            return message.channel.send(embed);
        }
        
        const embed = new MessageEmbed({ title: `\`${command_obj.commandName}\` command` });
        embed.addField('Group', command_obj.group);
        embed.addField('Info', command_obj.infos ?? 'None');
        embed.addField('Description', command_obj.description ?? 'None');
        embed.addField('Usage', `\`${command_obj.usage}\``);
        if (command_obj.aliases?.length) embed.addField('Aliases', `\`${command_obj.aliases.join(', ')}\``);
        message.channel.send(embed);
    }

    @Command('version', {
        infos: 'Get info about this version of HentaiBot',
        extraneous_argument_message: false
    })
    private async version(message: CommandMessage) {
        message.channel.send(`HentaiBot version \`${PACKAGE_VERSION} (${GIT_HASH})\` built with TypeScript version \`${TYPESCRIPT_VERSION}\``);
    }

    @Command('invite', {
        infos: 'Invite',
        description: 'Get invite link for bot',
        extraneous_argument_message: false
    })
    private async invite(message: CommandMessage, client: Client) {
        const user_count = new Set(client.guilds.cache.map(server => {
            return server.members.cache.map(member => {
                return member.user.id;
            });
        }).flat()).size;

        const embed = new MessageEmbed({
            title: 'Invite HentaiBot',
            url: `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=640928832`,
            thumbnail: {
                url: client.user.avatarURL()
            },
            fields: [{
                name: '\ufeff',
                value: `Running on ${client.guilds.cache.size} servers\nServing ${user_count} users`
            }]
        });

        message.channel.send(embed);
    }

    @Command('uptime', {
        infos: 'Get uptime',
        description: 'Get the uptime of this bot',
        extraneous_argument_message: false
    })
    private async uptime(message: CommandMessage) {
        const uptime_string = moment.duration(moment().diff(this.start_time)).format('w [weeks], d [days], h [hrs], m [minutes]');
        const start_string = this.start_time.format('MMM Do, Y, h:mm:ss A UTCZZ');

        message.channel.send(`${uptime_string} (since ${start_string})`);
    }

    @Guard(Owner())
    @Command('load_ext', {
        hide: true
    })
    private async load_ext(message: CommandMessage, module: string) {
        try {
            require(module);
            message.reply(`loaded module \`${module}\` successfully`);
        } catch (e) {
            message.reply(`error loading module \`${module}\`, \`${e.name} ${e.message}\``);
        }
    }
}