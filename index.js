// Load necessary modules
const fs = require('fs');
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionsBitField,
    SlashCommandBuilder,
    REST,
    Routes,
    MessageFlags
} = require('discord.js');
require('dotenv').config(); // Load .env file

// --- CONFIGURATION ---
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // IMPORTANT: Replace with your Server ID for instant command updates

// In-memory store for pending data (attachment and event type)
const pendingSubmissions = new Map();

// --- BOT CLIENT SETUP ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// --- COMMAND DEFINITIONS ---
const commands = [
    new SlashCommandBuilder()
        .setName('logevent')
        .setDescription('Submit a log for an event.')
        .addStringOption(option =>
            option.setName('eventtype')
                .setDescription('The type of event you are logging.')
                .setRequired(true)
                .setAutocomplete(true))
        .addAttachmentOption(option =>
            option.setName('proof')
                .setDescription('The image proof for the event.')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('setlogchannel')
        .setDescription('Sets the channel for event logs (Admin only).')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel to send logs to.')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('addeventtype')
        .setDescription('Adds a new type to the event list (Admin only).')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('The new event type to add.')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('removeeventtype')
        .setDescription('Removes a type from the event list (Admin only).')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('The event type to remove.')
                .setRequired(true)
                .setAutocomplete(true))
].map(command => command.toJSON());

// --- REGISTER COMMANDS ---
client.once('clientReady', async () => {  // FIXED: ready event name
    console.log(`Logged in as ${client.user.tag}!`);

    if (GUILD_ID) {
        const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
        try {
            console.log('Started refreshing application (/) commands.');
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
            console.log('Successfully reloaded application (/) commands.');
        } catch (error) {
            console.error(error);
        }
    }
});

// --- INTERACTIONS HANDLER ---
client.on('interactionCreate', async interaction => {
    // --- AUTOCOMPLETE ---
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'logevent' || interaction.commandName === 'removeeventtype') {
            const focusedValue = interaction.options.getFocused();
            const filtered = config.eventTypes.filter(choice => choice.toLowerCase().startsWith(focusedValue.toLowerCase()));
            await interaction.respond(filtered.map(choice => ({ name: choice, value: choice })));
        }
        return;
    }

    // --- CHAT INPUT COMMANDS ---
    if (interaction.isChatInputCommand()) {
        const memberIsAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

        if (interaction.commandName === 'logevent') {
            const eventType = interaction.options.getString('eventtype');
            const attachment = interaction.options.getAttachment('proof');

            if (!attachment || !attachment.contentType.startsWith('image/')) {
                return interaction.reply({ content: 'Please attach a valid image file as proof.', flags: [MessageFlags.Ephemeral] });
            }

            pendingSubmissions.set(interaction.user.id, {
                proofUrl: attachment.url,
                eventType: eventType
            });

            const modal = new ModalBuilder()
                .setCustomId('eventLogModal')
                .setTitle('Event Log Submission');

            const hostInput = new TextInputBuilder()
                .setCustomId('hostUsername')
                .setLabel("What is the host's username?")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const timeInput = new TextInputBuilder()
                .setCustomId('eventTime')
                .setLabel('Event Time (e.g., 8:30 PM EST)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(hostInput),
                new ActionRowBuilder().addComponents(timeInput)
            );

            await interaction.showModal(modal);
        }

        // --- ADMIN COMMANDS ---
        if (interaction.commandName === 'setlogchannel') {
            if (!memberIsAdmin) return interaction.reply({ content: 'You do not have permission to use this command.', flags: [MessageFlags.Ephemeral] });
            const channel = interaction.options.getChannel('channel');
            config.logChannelId = channel.id;
            fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
            return interaction.reply({ content: `Log channel has been set to ${channel}`, flags: [MessageFlags.Ephemeral] });
        }

        if (interaction.commandName === 'addeventtype') {
            if (!memberIsAdmin) return interaction.reply({ content: 'You do not have permission to use this command.', flags: [MessageFlags.Ephemeral] });
            const newType = interaction.options.getString('type');
            if (config.eventTypes.includes(newType)) return interaction.reply({ content: `'${newType}' is already in the event list.`, flags: [MessageFlags.Ephemeral] });
            config.eventTypes.push(newType);
            fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
            return interaction.reply({ content: `Event type '${newType}' has been added.`, flags: [MessageFlags.Ephemeral] });
        }

        if (interaction.commandName === 'removeeventtype') {
            if (!memberIsAdmin) return interaction.reply({ content: 'You do not have permission to use this command.', flags: [MessageFlags.Ephemeral] });
            const typeToRemove = interaction.options.getString('type');
            config.eventTypes = config.eventTypes.filter(t => t !== typeToRemove);
            fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
            return interaction.reply({ content: `Event type '${typeToRemove}' has been removed.`, flags: [MessageFlags.Ephemeral] });
        }
    }

    // --- MODAL SUBMISSIONS ---
    if (interaction.isModalSubmit() && interaction.customId === 'eventLogModal') {
        const hostUsername = interaction.fields.getTextInputValue('hostUsername');
        const eventTime = interaction.fields.getTextInputValue('eventTime');

        const pendingData = pendingSubmissions.get(interaction.user.id);
        pendingSubmissions.delete(interaction.user.id);

        if (!pendingData) return interaction.reply({ content: 'An error occurred: session data not found. Please try again.', flags: [MessageFlags.Ephemeral] });

        const { proofUrl, eventType } = pendingData;
        const logChannel = await client.channels.fetch(config.logChannelId).catch(() => null);

        if (!logChannel) return interaction.reply({ content: 'Error: The log channel could not be found. Please ask an admin to set it with `/setlogchannel`.', flags: [MessageFlags.Ephemeral] });

        const logEmbed = new EmbedBuilder()
            .setColor(0x00AE86)
            .setTitle('New Event Log Submitted')
            .addFields(
                { name: 'Submitted By', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
                { name: 'Host\'s Username', value: hostUsername, inline: true },
                { name: 'Event Type', value: eventType, inline: true },
                { name: 'Event Time', value: eventTime, inline: false }
            )
            .setImage(proofUrl)
            .setTimestamp()
            .setFooter({ text: `Event Logger` });

        await logChannel.send({ embeds: [logEmbed] });
        await interaction.reply({ content: 'Your event has been logged successfully! Thank you.', flags: [MessageFlags.Ephemeral] });
    }
});

// --- LOGIN THE BOT ---
client.login(BOT_TOKEN);
