const fs = require('fs');
const path = require('path');
const express = require('express');
const writeFileAtomic = require('write-file-atomic');
const crypto = require('crypto');
const sanitize = require('sanitize-filename');

const readFile = fs.promises.readFile;
const readdir = fs.promises.readdir;

const { jsonParser } = require('../express-common');
const { DIRECTORIES } = require('../constants');
const { readAndParseJsonlFile, timestampToMoment, humanizedToDate, calculateDuration, minDate, maxDate, now } = require('../util');

const statsFilePath = 'public/stats.json';

const MIN_TIMESTAMP = 0;
const MAX_TIMESTAMP = new Date('9999-12-31T23:59:59.999Z').getTime();
const MIN_DATE = new Date(MIN_TIMESTAMP);
const MAX_DATE = new Date(MAX_TIMESTAMP);
const CURRENT_STATS_VERSION = '1.1';

/** @type {StatsCollection} The collection of all stats, accessable via their key - gets set/built on init */
let globalStats;
let lastSaveDate = MIN_DATE;

/**
 * Loads the stats file into memory. If the file doesn't exist or is invalid,
 * initializes stats by collecting and creating them for each character.
 */
async function init() {
    try {
        const statsFileContent = await readFile(statsFilePath, 'utf-8');
        const obj = JSON.parse(statsFileContent);
        // Migrate/recreate stats if the version has changed
        if (obj.version !== CURRENT_STATS_VERSION) {
            console.info(`Found outdated stats of version '${obj.version}'. Recreating stats for current version '${CURRENT_STATS_VERSION}'...`);
            await recreateStats();
        }
        globalStats = obj;
    } catch (err) {
        // If the file doesn't exist or is invalid, initialize stats
        if (err.code === 'ENOENT' || err instanceof SyntaxError) {
            recreateStats();
        } else {
            throw err; // Rethrow the error if it's something we didn't expect
        }
    }
}

/**
 * Attempts to save charStats to a file and then terminates the process.
 * If an error occurs during the file write, it logs the error before exiting.
 */
async function onExit() {
    try {
        await saveStatsToFile();
    } catch (err) {
        console.error('Failed to write stats to file:', err);
    }
}

/**
 * @typedef {object} MessageLine - The chat message object to process.
 */

/**
 * @typedef {object} StatsCollection - An object holding all character stats, and some additional main stats
 * @property {string} version - Version number indication the version of this stats data - so it can be automatically migrated/recalculated if any of the calculation logic changes
 * @property {CharacterStats} global - global characer stats
 * @property {{[characterKey: string]: CharacterStats}} stats - All the dynamically saved stats objecs
 * @property {Date} _calculated -
 * @property {Date} _recalcualted -
 */

/**
 * @typedef {object} CharacterStats
 * @property {string} name -
 * @property {string} characterKey -
 * @property {number} chats - The creation date of the chat.
 * @property {number} chatSize - The size of all chats
 *
 * @property {Date} firstCreateDate -
 * @property {Date} lastCreateDate -
 * @property {Date} firstlastInteractionDate -
 * @property {Date} lastLastInteractionDate -
 *
 * @property {AggregateStat} chattingTime -
 * @property {AggregateStat} messages -
 * @property {AggregateStat} systemMessages -
 * @property {AggregateStat} userMessages -
 * @property {AggregateStat} charMessages -
 *
 * @property {AggregateStat} genTime -
 * @property {AggregateStat} genTokenCount -
 * @property {AggregateStat} swipeGenTime -
 * @property {AggregateStat} swipes -
 * @property {AggregateStat} userResponseTime -
 * @property {AggregateStat} words -
 * @property {AggregateStat} userWords -
 * @property {AggregateStat} charWords -
 *
 * @property {AggregateStat} perMessageGenTime -
 * @property {AggregateStat} perMessageGenTokenCount -
 * @property {AggregateStat} perMessageSwipeGenTime -
 * @property {AggregateStat} perMessageSwipeCount -
 * @property {AggregateStat} perMessageUserResponseTime -
 * @property {AggregateStat} perMessageWords -
 * @property {AggregateStat} perMessageUserWords -
 * @property {AggregateStat} perMessageCharWords -
 *
 * @property {{[model: string]: { count: number, tokens: number}}} genModels - model usages
 * @property {ChatStats[]} chatsStats -
 * @property {Date} _calculated -
 */

/**
 * @typedef {object} ChatStats
 * @property {string} chatName - The unique identifier for the chat.
 * @property {number} chatId - hash
 * @property {number} chatSize -
 * @property {Date} createDate - The creation date of the chat. (time in ISO 8601 format)
 * @property {Date} lastInteractionDate - (time in ISO 8601 format)
 *
 * @property {number} chattingTime -
 * @property {number} messages -
 * @property {number} systemMessages -
 * @property {number} userMessages -
 * @property {number} charMessages -
 *
 * @property {AggregateStat} genTime -
 * @property {AggregateStat} genTokenCount -
 * @property {AggregateStat} swipeGenTime -
 * @property {AggregateStat} swipes -
 * @property {AggregateStat} userResponseTime -
 * @property {AggregateStat} words -
 * @property {AggregateStat} userWords -
 * @property {AggregateStat} charWords -
 *
 * @property {{[model: string]: { count: number, tokens: number}}} genModels - model usages
 * @property {MessageStats[]} messagesStats - An array of MessageStats objects for individual message analysis.
 * @property {Date} _calculated -
 */

/**
 * @typedef {object} MessageStats
 * @property {boolean} isUser -
 * @property {boolean} isChar -
 * @property {string} hash -
 * @property {Date} sendDate - The time when the message was sent.
 * @property {number?} genTime - The total time taken to generate this message and all swipes.
 * @property {number?} genTokenCount -
 * @property {number?} swipeGenTime - The total generation time for all swipes excluding the first generation.
 * @property {number?} swipes - The count of additional swipes minus the first generated message.
 * @property {number} words - The number of words in the message.
 * @property {Date[]} genEndDates -
 * @property {{[model: string]: { count: number, tokens: number}}} genModels - model usages
 * @property {Date} _calculated -
 */

/**
 * An object that aggregates stats for a specific value
 *
 * By adding values to it, it'll automatically recalculate min, max and average
 */
class AggregateStat {
    /** @type {number} The number of stats used for this aggregation - used for recalculating avg */
    count = 0;
    /** @type {number} Total / Sum */
    total = 0;
    /** @type {number} Minimum value */
    min = Number.NaN;
    /** @type {number} Maximum value */
    max = 0;
    /** @type {number} Average value */
    avg = 0;
    /** @type {number[]} All values listed and saved, so the aggregate stats can be updated if needed when elements get removed */
    values = [];
    constructor() { }

    reset() {
        this.count, this.total, this.min, this.max, this.avg = 0;
    }

    /**
     * Adds a given value to this aggregation
     * If you want to add all values of an `AggregateStat`, use `addAggregated`
     * @param {number?} value - The value to add
     */
    add(value) {
        if (value === null || isNaN(value)) return;
        this.count++;
        this.total += value;
        this.avg = this.total / this.count;

        this.values.push(value);
        this.min = Math.min(isNaN(this.min) ? Number.MAX_SAFE_INTEGER : this.min, value);
        this.max = Math.max(this.max, value);
    }

    /**
     * Adds all values of a given aggregation as single values
     * @param {AggregateStat} aggregatedValue - The aggregate stat
     */
    addAggregated(aggregatedValue) {
        aggregatedValue.values.forEach(x => this.add(x));
    }

    /**
     * Removes a given value from this aggregation
     * If you want to remove all values of an `AggregateStat`, use `removeAggregated`
     * @param {number?} value - The value to remove
     */
    remove(value) {
        if (value === null || isNaN(value)) return;

        this.count--;
        this.total -= value;
        this.avg = this.count === 0 ? 0 : this.total / this.count;

        const index = this.values.indexOf(value);
        if (index === -1) {
            console.warn(`Tried to remove aggregation value ${value} that does not exist. This should not happen...`);
            return;
        }
        this.values.splice(index, 1);

        if (value === this.min) {
            this.min = this.values.length > 0 ? Math.min(...this.values) : Number.NaN;
        }
        if (value === this.max) {
            this.max = this.values.length > 0 ? Math.max(...this.values) : 0;
        }
    }

    /**
     * Removes all values of a given aggregation as their respective values
     * @param {AggregateStat} aggregatedValue - The aggregate stat
     */
    removeAggregated(aggregatedValue) {
        aggregatedValue.values.forEach(x => this.add(x));
    }
}

/**
 *
 *
 * @returns {Promise<StatsCollection>} The aggregated stats object.
 */
async function recreateStats() {
    console.log('Collecting and creating stats...');

    /** @type {StatsCollection}  */
    const EMPTY_GLOBAL_STATS = { _calculated: MIN_DATE, _recalcualted: MIN_DATE, version: CURRENT_STATS_VERSION, global: newCharacterStats('global', 'Global'), stats: {} };

    // Resetting global stats first
    globalStats = { ...EMPTY_GLOBAL_STATS, };

    // Load all char files to process their chat folders
    const files = await readdir(DIRECTORIES.characters);
    const charFiles = files.filter((file) => file.endsWith('.png'));
    let processingPromises = charFiles.map((charFileName, _) =>
        recreateCharacterStats(charFileName.replace('.png', '')),
    );
    await Promise.all(processingPromises);

    // Remember the date at which those stats were recalculated from the ground up
    globalStats._recalcualted = now();

    await saveStatsToFile();
    console.debug('Stats (re)created and saved to file.');

    return globalStats;
}

/**
 * Recreates stats for a specific character.
 * Should be used very carefully, as it still has to recalculate most of the global stats.
 *
 * @param  {string} characterKey
 * @return {CharacterStats?}
 */
function recreateCharacterStats(characterKey) {
    // If we are replacing on a existing global stats, we need to "remove" all old stats
    if (globalStats.stats[characterKey]) {
        for (const chatStats of globalStats.stats[characterKey].chatsStats) {
            removeChatFromCharStats(globalStats.global, chatStats);
        }
        delete globalStats.stats[characterKey];
    }

    // Then load chats dir for this character to process
    const charChatsDir = path.join(DIRECTORIES.chats, characterKey);
    if (!fs.existsSync(charChatsDir)) {
        return null;
    }

    const chatFiles = fs.readdirSync(charChatsDir);
    chatFiles.forEach(chatName => {
        triggerChatUpdate(characterKey, chatName);
    });

    return globalStats[characterKey];
};


/**
 *
 * @param {string} charChatsDir - The directoy path
 * @param {string} chatName
 * @returns {{chatName: string, lines: object[]}}
 */
function loadChatFile(charChatsDir, chatName) {
    const fullFilePath = path.join(charChatsDir, sanitize(chatName));
    const lines = readAndParseJsonlFile(fullFilePath);
    return { chatName, lines };
}

/**
 *
 *
 * @param {string} characterKey - The character key
 * @param {string} chatName - The name of the chat
 * @returns {ChatStats?}
 */
function triggerChatUpdate(characterKey, chatName) {
    const charName = characterKey.replace('.png', '');
    const charChatsDir = path.join(DIRECTORIES.chats, charName);

    // Load and process chats to get its stats
    const loadedChat = loadChatFile(charChatsDir, chatName);
    const fsStats = fs.statSync(path.join(charChatsDir, chatName));

    const chatStats = processChat(chatName, loadedChat.lines, { chatSize: fsStats.size });
    if (chatStats === null) {
        return null;
    }

    // Create empty stats if character stats don't exist yet
    globalStats.stats[characterKey] ??= newCharacterStats(characterKey, charName);

    // Update char stats with the processed chat stats
    updateCharStatsWithChat(globalStats.stats[characterKey], chatStats);

    // Update the global stats with this chat
    updateCharStatsWithChat(globalStats.global, chatStats);

    chatStats._calculated = now();
    globalStats._calculated = now();
    return chatStats;
}

/**
 * Recalculates character stats based on the current chat.
 * Works with both updating/replacing an existing chat and also adding a new one.
 *
 * @param {CharacterStats} stats - The stats of the character
 * @param {ChatStats} chatStats - The chat stats to add/update
 * @returns {boolean}
 */
function updateCharStatsWithChat(stats, chatStats) {
    // Check if we need to remove this chat's previous data first
    removeChatFromCharStats(stats, chatStats);

    stats.chatsStats.push(chatStats);

    stats.chats++;
    stats.chatSize += chatStats.chatSize;
    stats.firstCreateDate = minDate(chatStats.createDate, stats.firstCreateDate) ?? stats.firstCreateDate;
    stats.lastCreateDate = maxDate(chatStats.createDate, stats.lastCreateDate) ?? stats.lastCreateDate;
    stats.firstlastInteractionDate = minDate(chatStats.lastInteractionDate, stats.firstlastInteractionDate) ?? stats.firstlastInteractionDate;
    stats.lastLastInteractionDate = maxDate(chatStats.lastInteractionDate, stats.lastLastInteractionDate) ?? stats.lastLastInteractionDate;

    stats.chattingTime.add(chatStats.chattingTime);
    stats.messages.add(chatStats.messages);
    stats.systemMessages.add(chatStats.systemMessages);
    stats.userMessages.add(chatStats.userMessages);
    stats.charMessages.add(chatStats.charMessages);

    stats.genTime.add(chatStats.genTime.total);
    stats.genTokenCount.add(chatStats.genTokenCount.total);
    stats.swipeGenTime.add(chatStats.swipeGenTime.total);
    stats.swipes.add(chatStats.swipes.total);
    stats.userResponseTime.add(chatStats.userResponseTime.total);
    stats.words.add(chatStats.words.total);
    stats.userWords.add(chatStats.userWords.total);
    stats.charWords.add(chatStats.charWords.total);

    stats.perMessageGenTime.addAggregated(chatStats.genTime);
    stats.perMessageGenTokenCount.addAggregated(chatStats.genTokenCount);
    stats.perMessageSwipeGenTime.addAggregated(chatStats.swipeGenTime);
    stats.perMessageSwipeCount.addAggregated(chatStats.swipes);
    stats.perMessageUserResponseTime.addAggregated(chatStats.userResponseTime);
    stats.perMessageWords.addAggregated(chatStats.words);
    stats.perMessageUserWords.addAggregated(chatStats.userWords);
    stats.perMessageCharWords.addAggregated(chatStats.charWords);

    Object.entries(chatStats.genModels).forEach(([model, data]) => addModelUsage(stats.genModels, model, data.tokens, data.count));

    stats._calculated = now();
    console.debug(`Successfully updated ${stats.name}'s stats with chat ${chatStats.chatName}`);
    return true;
}

/**
 * Removes the given chat stats from the character stats
 * Both removing the saved stats object and also "calculating it out" of all existing values
 * @param {CharacterStats} stats - The stats of the character
 * @param {ChatStats} chatStats - The chat stats to remove
 * @returns {boolean} Whether existed and was removed
 */
function removeChatFromCharStats(stats, chatStats) {
    const index = stats.chatsStats.findIndex(x => x.chatName == chatStats.chatName);
    if (index === -1) {
        return false;
    }
    this.values.splice(index, 1);

    stats.chats--;
    stats.chatSize -= chatStats.chatSize;
    stats.firstCreateDate = minDate(chatStats.createDate, stats.firstCreateDate) ?? stats.firstCreateDate;
    stats.lastCreateDate = maxDate(chatStats.createDate, stats.lastCreateDate) ?? stats.lastCreateDate;
    stats.firstlastInteractionDate = minDate(chatStats.lastInteractionDate, stats.firstlastInteractionDate) ?? stats.firstlastInteractionDate;
    stats.lastLastInteractionDate = maxDate(chatStats.lastInteractionDate, stats.lastLastInteractionDate) ?? stats.lastLastInteractionDate;

    stats.chattingTime.remove(chatStats.chattingTime);
    stats.messages.remove(chatStats.messages);
    stats.systemMessages.remove(chatStats.systemMessages);
    stats.userMessages.remove(chatStats.userMessages);
    stats.charMessages.remove(chatStats.charMessages);

    stats.genTime.remove(chatStats.genTime.total);
    stats.genTokenCount.remove(chatStats.genTokenCount.total);
    stats.swipeGenTime.remove(chatStats.swipeGenTime.total);
    stats.swipes.remove(chatStats.swipes.total);
    stats.userResponseTime.remove(chatStats.userResponseTime.total);
    stats.words.remove(chatStats.words.total);
    stats.userWords.remove(chatStats.userWords.total);
    stats.charWords.remove(chatStats.charWords.total);

    stats.perMessageGenTime.removeAggregated(chatStats.genTime);
    stats.perMessageGenTokenCount.removeAggregated(chatStats.genTokenCount);
    stats.perMessageSwipeGenTime.removeAggregated(chatStats.swipeGenTime);
    stats.perMessageSwipeCount.removeAggregated(chatStats.swipes);
    stats.perMessageUserResponseTime.removeAggregated(chatStats.userResponseTime);
    stats.perMessageWords.removeAggregated(chatStats.words);
    stats.perMessageUserWords.removeAggregated(chatStats.userWords);
    stats.perMessageCharWords.removeAggregated(chatStats.charWords);

    Object.entries(chatStats.genModels).forEach(([model, data]) => removeModelUsage(stats.genModels, model, data.tokens, data.count));

    console.debug(`Successfully removed old chat stats for chat ${chatStats.chatName}`);
    return true;
}

/**
 *
 * @param {string} chatName
 * @param {object[]} lines
 * @param {{chatSize?: number}} [param0={}] - optional parameter that can be set when processing the chat
 * @return {ChatStats?}
 */
function processChat(chatName, lines, { chatSize = 0 } = {}) {
    if (!lines.length) {
        console.warn('Processing chat file failed.');
        return null;
    }

    /** @type {ChatStats} build the stats object first, then fill */
    const stats = newChatStats(chatName);

    // Fill stats that we already can
    stats.chatSize = chatSize;

    /** @type {MessageStats?} Always remember the message before, for calculations */
    let lastMessage = null;

    // Process each message
    for (const message of lines) {
        // Check if this is the first message, the "data storage"
        if (message.chat_metadata && message.create_date) {
            stats.createDate = humanizedToDate(message.create_date) ?? stats.createDate;
            stats.chatId = message.chat_metadata['chat_id_hash'];
            continue;
        }

        const messageStats = processMessage(message);
        stats.messagesStats.push(messageStats);

        stats.lastInteractionDate = maxDate(stats.lastInteractionDate, messageStats.sendDate, ...messageStats.genEndDates) ?? stats.lastInteractionDate;

        // Aggregate chat stats for each message
        // stats.chattingTime - is calculated at the end of message progressing
        stats.messages += 1;
        stats.systemMessages += message.is_system ? 1 : 0;
        stats.userMessages += messageStats.isUser ? 1 : 0;
        stats.charMessages += messageStats.isChar ? 1 : 0;

        stats.genTime.add(messageStats.genTime);
        stats.genTokenCount.add(messageStats.genTokenCount)
        stats.swipeGenTime.add(messageStats.swipeGenTime);
        stats.swipes.add(messageStats.swipes);

        // If this is a user message, we calculate the response time from the last interaction of the message before
        if (messageStats.isUser && lastMessage !== null) {
            const lastInteractionBefore = lastMessage.genEndDates.sort().findLast(x => x < messageStats.sendDate) ?? lastMessage.sendDate;
            const responseTime = calculateDuration(lastInteractionBefore, messageStats.sendDate);
            stats.userResponseTime.add(responseTime);
        }

        stats.words.add(messageStats.words);
        stats.userWords.add(messageStats.isUser ? messageStats.words : null);
        stats.charWords.add(messageStats.isChar ? messageStats.words : null);

        Object.entries(messageStats.genModels).forEach(([model, data]) => addModelUsage(stats.genModels, model, data.tokens, data.count));

        // Remember this as the last message, for time calculations
        lastMessage = messageStats;
    }

    // Set up the final values for chat
    stats.chattingTime = calculateDuration(stats.createDate, stats.lastInteractionDate);

    return stats;
}

/**
 * Process a chat message and calculate relevant stats
 * @param {MessageLine} message - The parsed json message line
 * @returns {MessageStats}
 */
function processMessage(message, name = null) {
    /** @type {MessageStats} build the stats object first, then fill */
    const stats = newMessageStats();

    stats.isUser = message.is_user;
    stats.isChar = !message.is_user && !message.is_system && (!name || message.name == name);
    stats.hash = crypto.createHash('sha256').update(message.mes).digest('hex');

    // Count all additional swipes (this array stores the original message too)
    stats.swipes = message.swipe_info?.length ? message.swipe_info.length - 1 : null;

    // Use utility functions to process each message
    stats.words = countWordsInString(message.mes);
    stats.sendDate = new Date(timestampToMoment(message.send_date) ?? MIN_TIMESTAMP);

    // Only calculate generation time and token count for model messages
    if (!message.is_user) {
        if (message.gen_started && message.gen_finished) {
            stats.genTokenCount = message.extra?.token_count || 0;
            stats.genTime = calculateDuration(message.gen_started, message.gen_finished);
            stats.genEndDates.push((new Date(message.gen_finished)));
            addModelUsage(stats.genModels, message.extra?.model, message.extra?.token_count);
        }

        // Sum up swipes. As swiping time counts everything that was not the last, final chosen message
        // We also remember the highest timestamp for this message as the "last action"
        message.swipe_info?.filter(x => x.gen_started !== message.gen_started && x.gen_started && x.gen_finished)
            .forEach(swipeInfo => {
                stats.genTokenCount = (stats.genTokenCount ?? 0) + message.extra?.token_count || 0;
                const swipeGenTime = calculateDuration(swipeInfo.gen_started, swipeInfo.gen_finished);
                stats.genTime = (stats.genTime ?? 0) + swipeGenTime;
                stats.swipeGenTime = (stats.swipeGenTime ?? 0) + swipeGenTime;
                stats.genEndDates.push((new Date(swipeInfo.gen_finished)));
                addModelUsage(stats.genModels, swipeInfo.extra?.model, swipeInfo.extra?.token_count);
            });
    }

    stats._calculated = now();
    return stats;
}

/** @param {{[model: string]: { count: number, tokens: number}}} obj, @param {string} model, @param {number} tokens @param {number} count */
function addModelUsage(obj, model, tokens, count = 1) {
    if (!model) return;
    obj[model] ??= { count: 0, tokens: 0 };
    obj[model].count += (count ?? 1);
    obj[model].tokens += (tokens ?? 0);
}

/** @param {{[model: string]: { count: number, tokens: number}}} obj, @param {string} model, @param {number} tokens @param {number} count */
function removeModelUsage(obj, model, tokens, count = 1) {
    if (!model || !obj[model]) return;
    obj[model].count -= (count ?? 1);
    obj[model].tokens -= (tokens ?? 0);
    if (obj[model].count <= 0)
        delete obj[model];
}

/**
 * Counts the number of words in a string.
 *
 * @param {string} str - The string to count words in.
 * @returns {number} - The number of words in the string.
 */
function countWordsInString(str) {
    return str.match(/\b\w+\b/g)?.length ?? 0;
}

/**
 * Creates a new, empty character stats object
 * @param {string} characterKey - The character key
 * @param {string} charName - The characters' name
 * @returns {CharacterStats}
 */
function newCharacterStats(characterKey = '', charName = '') {
    return {
        name: charName,
        characterKey: characterKey,
        chats: 0,
        chatSize: 0,

        firstCreateDate: MIN_DATE,
        lastCreateDate: MIN_DATE,
        firstlastInteractionDate: MIN_DATE,
        lastLastInteractionDate: MIN_DATE,

        chattingTime: new AggregateStat(),
        messages: new AggregateStat(),
        systemMessages: new AggregateStat(),
        userMessages: new AggregateStat(),
        charMessages: new AggregateStat(),

        genTime: new AggregateStat(),
        genTokenCount: new AggregateStat(),
        swipeGenTime: new AggregateStat(),
        swipes: new AggregateStat(),
        userResponseTime: new AggregateStat(),
        words: new AggregateStat(),
        userWords: new AggregateStat(),
        charWords: new AggregateStat(),

        perMessageGenTime: new AggregateStat(),
        perMessageGenTokenCount: new AggregateStat(),
        perMessageSwipeGenTime: new AggregateStat(),
        perMessageSwipeCount: new AggregateStat(),
        perMessageUserResponseTime: new AggregateStat(),
        perMessageWords: new AggregateStat(),
        perMessageUserWords: new AggregateStat(),
        perMessageCharWords: new AggregateStat(),

        genModels: {},
        chatsStats: [],
        _calculated: now(),
    };
}

/**
 * Creates a new, empty chat stats object
 * @param {string} chatName - The chats' name
 * @returns {ChatStats}
 */
function newChatStats(chatName) {
    return {
        chatName: chatName,
        chatId: 0,
        chatSize: 0,
        createDate: MIN_DATE,
        lastInteractionDate: MIN_DATE,

        chattingTime: 0,
        messages: 0,
        systemMessages: 0,
        userMessages: 0,
        charMessages: 0,

        genTime: new AggregateStat(),
        genTokenCount: new AggregateStat(),
        swipeGenTime: new AggregateStat(),
        swipes: new AggregateStat(),
        userResponseTime: new AggregateStat(),
        words: new AggregateStat(),
        userWords: new AggregateStat(),
        charWords: new AggregateStat(),

        genModels: {},
        messagesStats: [],
        _calculated: now(),
    };
}

/**
 * Creates a new, empty message stats object
 * @returns {MessageStats}
 */
function newMessageStats() {
    return {
        isUser: false,
        isChar: false,
        hash: '',
        sendDate: MIN_DATE,
        genTime: null,
        genTokenCount: null,
        swipeGenTime: null,
        swipes: null,
        words: 0,
        genEndDates: [],
        genModels: {},
        _calculated: now(),
    };
}

/**
 * Saves the current state of charStats to a file, only if the data has changed since the last save.
 */
async function saveStatsToFile() {
    if (globalStats._calculated > lastSaveDate) {
        //console.debug("Saving stats to file...");
        try {
            await writeFileAtomic(statsFilePath, JSON.stringify(globalStats));
            lastSaveDate = now();
        } catch (error) {
            console.log('Failed to save stats to file.', error);
        }
    } else {
        //console.debug('Stats have not changed since last save. Skipping file write.');
    }
}

/**
 * Returns the current global stats object
 * @returns {StatsCollection}
 **/
function getGlobalStats() {
    return globalStats;
}

const router = express.Router();


/**
 * @typedef {object} StatsRequestBody
 * @property {boolean?} [global] - Whether the global stats are requested. If true, all other arguments are ignored
 * @property {string?} [characterKey] - The character key for the character to request stats from
 * @property {string?} [chatName] - The name of the chat file
 */

/**
 * Handle a POST request to get the stats fromm
 *
 * This function returns the stats object that was calculated and updated based on the chats.
 * Depending on the given request filter, it will either return global stats, character stats or chat stats.
 *
 * @param {Object} request - The HTTP request object.
 * @param {Object} response - The HTTP response object.
 * @returns {void}
 */
router.post('/get', jsonParser, function (request, response) {
    const send = (data) => response.send(JSON.stringify(data ?? {}));
    /** @type {StatsRequestBody} */
    const body = request.body;

    if (!!body.global) {
        return send(globalStats.global);
    }

    const characterKey = String(body.characterKey);
    const chatName = String(body.characterKey);
    if (characterKey && chatName) {
        return send(globalStats.stats[characterKey]?.chatsStats.find(x => x.chatName == chatName));
    }
    if (characterKey) {
        return send(globalStats.stats[characterKey]);
    }

    // If no specific filter was requested, we send all stats back
    return send(globalStats);
});

/**
 * Triggers the recreation of statistics from chat files.
 * - If successful: returns a 200 OK status.
 * - On failure: returns a 500 Internal Server Error status.
 *
 * @param {Object} request - Express request object.
 * @param {Object} response - Express response object.
 */
router.post('/recreate', jsonParser, async function (request, response) {
    const send = (data) => response.send(JSON.stringify(data ?? {}));
    /** @type {StatsRequestBody} */
    const body = request.body;

    try {
        const characterKey = String(body.characterKey);
        if (characterKey) {
            recreateCharacterStats(characterKey);
            return send(globalStats.stats[characterKey]);
        }
        await recreateStats();
        return send(globalStats);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

module.exports = {
    router,
    init,
    onExit,
};
