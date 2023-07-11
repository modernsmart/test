/**
 * import necessary libraries 
 * if not installed enter "npm install [library name]" in the terminal
 * troubleshooting:
 * @https://www.npmjs.com/package/puppeteer-chromium-resolver
 * https://stackoverflow.com/questions/74362083/cloud-functions-puppeteer-cannot-open-browser
 * https://github.com/puppeteer/puppeteer/issues/1597
 *
 * resources:
 * command to kill port: kill -9 $(lsof -t -i:8080)
 * https://www.kindacode.com/article/node-js-how-to-use-import-and-require-in-the-same-file/
 * https://brunoscheufler.com/blog/2021-05-31-locking-and-synchronization-for-nodejs
 * https://www.youtube.com/watch?v=PFJNJQCU_lo
 * https://dev.to/pedrohase/create-google-calender-events-using-the-google-api-and-service-accounts-in-nodejs-22m8
 */

// IMPORTS
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import { Mutex } from 'async-mutex';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import pAll from 'p-all';
import { publishMessage, replyMessage, findMessage } from "./slack.js";

const prompt = require('prompt');
const puppeteerExtra = require('puppeteer-extra');
const fs = require('fs').promises;
const PCR = require("puppeteer-chromium-resolver");
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const schedule = require('node-schedule');
const credentials = require('./google_credentials.json');
const dotenv = require('dotenv');
dotenv.config();

// CONSTANTS
const mutex = new Mutex();
const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
const calendar = google.calendar({ version: 'v3', auth });
const sheets = google.sheets({version: "v4", auth})
const calendarId = "monitoring@modernsmart.com";
const spreadsheetId = "1dM7QHKB7G67V84EtPUKXffJsIE74hN3OwQT4g2PLuek";

const DATE_REGEX = /(\d?\d:\d\d):\d\d\s(\w\w)/;
const CANCELLED_REGEX = /^\((C|c)ancel/;
const EMAIL = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/;
const ABSENT = 0;
const PRESENT = 1;
const CHANNEL_ID = "C04EQQT98PN";
// const CHANNEL_ID = "C05D0U9S75J"; // TEST

class Event {
    title;
    startTime;
    endTime;
    meetLink;

    constructor(title, startTime, endTime, meetLink) {
        this.title = title;
        this.startTime = startTime;
        this.endTime = endTime;
        this.meetLink = meetLink;
    }
}

class AttendanceBot {
    context;
    page;

    constructor(context, page) {
        this.context = context;
        this.page = page;
    }

    /**
     * Initializes instance of Chromium using puppeteer
     * See puppeteer documentation @https://pptr.dev/ 
     * @returns AttendanceBot object
     */
    //https://dev.to/somedood/the-proper-way-to-write-async-constructors-in-javascript-1o8c
    static async initialize(browser) {
        const context = await browser.createIncognitoBrowserContext();
        const page = await context.newPage();
        return new AttendanceBot(context, page);
    }

    /**
     * Uses login credential to sign into Google account.
     * Goes to session URL and joins.
     * @param {*} meetLink 
     */
    async joinSession(meetLink) {
        const page = this.page;
        const filePath = './cookies.json'

        // wait maximum amount of time for page to load
        await page.setDefaultTimeout(0);
        await page.setDefaultNavigationTimeout(0);

        // load cookies and try to use them, if unsuccessful, perform google login
        // try {
        //     const savedCookies = await loadCookies(filePath);
        //     if (areCookiesValid(savedCookies)) {
        //         await page.setCookie(...savedCookies);
        //     } else {
        //         throw Error("bad cookies");
        //     }
        // } catch (e) {
        //     console.log(e);
        
            // log into gmail account using .env credentials
            try {
                console.log("logging into gmail...");
                await page.goto('https://accounts.google.com/signin/v2/identifier', {waitUntil: 'load', timeout: 0});
                await page.type('[type="email"]', process.env.GMAIL);
                await page.click('#identifierNext');
                await sleep(2000);

                await page.type('[type="password"]', process.env.PASSWORD);
                await page.click('#passwordNext');
                await sleep(2000);
            } catch {
                throw Error("unable to log in :(")
            }

        // }

        // save cookies (comment-out when deploying as cloud function because cookies.json becomes a read-only file)
        // console.log("saving cookies...");
        // mutex.runExclusive(() => saveCookies(page, filePath));

        // go to meet url
        console.log("going to link @ " + meetLink + "...");
        await page.goto(meetLink, { waitUntil: 'load', timeout: 0 });
        
        // join meet
        console.log("joining meet...")
        let count = 0;
        while (await this.isInMeet() === false && count < 6) {
            try {
                const joinButton = await page.waitForSelector('button[data-idom-class="nCP5yc AjY5Oe DuMIQc LQeN7 jEvJdc QJgqC"][jsname="Qx7uuf"]', {visible: true, timeout: 5 * 1000});
                await joinButton.click();
                await joinButton.dispose();
            } catch {
                console.log("retrying...");
                count++;
            }
        }
        if (await this.isInMeet() === false) {
            throw Error("unable to join :(");
        }

        // mute mic
        console.log("muting mic...");
        const muteButton = await page.waitForSelector('[jsaction="Az4Fr:Jv50ub"]', {visible: true});
        await muteButton.click();
        await muteButton.dispose();

        // handle popups (only appear once)
        console.log("dismissing popups...");
        let popup = await page.waitForSelector('text/Got it', {visible: true});
        await popup.click();
        await popup.dispose();
        await sleep(1000);
        popup = await page.waitForSelector('text/Got it', {visible: true});
        await popup.click();
        await popup.dispose();

        // open people tab
        console.log("opening people tab...");
        await page.evaluate(() => { document.querySelectorAll('[class="VfPpkd-Bz112c-LgbsSe yHy1rc eT1oJ JsuyRc boDUxc"]')[1].click();});
        console.log("session joined!");
        await sleep(1000);
    }

    async autoAdmit(interval) {
        const page = this.page;

        const elements = await page.$$('[class="VfPpkd-vQzf8d"]');
        elements.map(async element => {
            const text = await element.getProperty("textContent");
            const json = await text.jsonValue();
            if (json.toString() === "Admit") {
                await element.click();
            }
        });
        await sleep(interval)
    }

    /**
     * When inside session, takes attendance by reading guest list
     * @param {*} meetLink 
     */
    async takeAttendance(title, startTime, endTime, thread, interval) {
        const page = this.page;
        let log = "";

        // retrieve guest names
        const targets = await page.$$("[class='zWGUib']");
        const promises = await targets.map(async element => {
            const text = await element.getProperty("textContent");
            const json = await text.jsonValue();
            const name = json.toString();
            if (name.match(EMAIL)) {
                return {name, status: ABSENT};
            } else {
                return {name, status: PRESENT};
            }
        });
        await Promise.all(promises).then((guests) => {log += createLog(guests)});
        sendMessage(thread, log);
        // console.log(log);
        await sleep(interval);
        return log;
    }

    async leaveSession() {
        const page = this.page;
        await page.close();
        console.log("tab closed!");
        await sleep(1000);
    }

    async isInMeet() {
        const page = this.page;
        const element = await page.$('[class="P245vb"]');
        if (element) {
            return true;
        } else {
            return false;
        }
    }
}

async function monitorMeet(browser, event) {
    let attendanceLog = "";
    const startTime = event.startTime.getTime();
    const endTime = event.endTime.getTime();

    // create new window with new tab
    const bot = await AttendanceBot.initialize(browser);
    try {
        // join session
        await bot.joinSession(event.meetLink);

        // find or create Slack thread
        const text = buildMessage(event.title, event.startTime, event.endTime);
        const thread = await getThread(text);
        // console.log(thread);

        // auto admit until session begins
        console.log("enabling auto admit...")
        while (Date.now() < event.startTime) {
            if (await bot.isInMeet() === true) {
                await bot.autoAdmit(5 * 1000);
            } else {
                throw Error("bot removed :(");
            }
        }
        
        // auto admit AND take attendance
        await pAll([
            async () => {
                while ((new Date()) < Math.min(startTime + 5 * 60 * 1000, endTime)) {
                    if (await bot.isInMeet() === true) {
                        await bot.autoAdmit(5 * 1000);
                    } else {
                        throw Error("bot removed :(");
                    }
                }
            }, 
            async () => {
                console.log("taking attendance...");
                while ((new Date()) < Math.min(startTime + (15 * 60 * 1000) + (10 * 1000), endTime)) {
                    if (await bot.isInMeet() === true) {
                        const log = await bot.takeAttendance(event.title, startTime, endTime, thread,  3 * 60 * 1000);
                        // const log = await bot.takeAttendance(event.title, startTime, endTime, thread, 15 * 1000); // TEST
                    } else {
                        throw Error("bot removed :(");
                    }
                }
            },
        ]);

        // wait until end of session plus 5 minutes
        const untilEnd = event.endTime - Date.now();
        // console.log(untilEnd);
        await sleep(untilEnd + (5 * 60 * 1000));
    } catch (e) {
        console.log(e);
    } finally {
        // leave session and close tab
        await bot.leaveSession();
        console.log("closing context...");
        await bot.context.close();
        return attendanceLog;
    }
}

async function getEventData(timeMin, timeMax) {
    const events = [];
    const eventList = await calendar.events.list({
        calendarId,
        timeMin,
        timeMax,
        orderBy: "startTime", 
        singleEvents: true
    });
    const eventItems = eventList.data.items;
    for (const eventItem of eventItems) {
        const event = new Event(
            eventItem.summary, 
            new Date(eventItem.start.dateTime), 
            new Date(eventItem.end.dateTime), 
            eventItem.hangoutLink
        ); 
        if (event.title.match(CANCELLED_REGEX) == null && event.title != "Kwiseon Out of office" && event.title != "Kwiseon Off") {
            events.push(event);
        }
    }
    return events;
}

// HELPERS
/** 
 * saves cookies from the current execution so login credentials can be 
 * remembered between runs without hardcoding passwords
 * @param {Promise} page the current page object that cookies will be saved for
 * @returns {void}
 */
async function saveCookies(page, filePath) {
    const cookies = await page.cookies();
    await fs.writeFile(filePath, JSON.stringify(cookies, null, 2));
}

async function loadCookies(filePath) {
    const cookiesData = await fs.readFile(filePath);
    return JSON.parse(cookiesData);
}

function areCookiesValid(cookies) {
    // check if the cookies array is empty
    if (cookies.length === 0) {
      return false;
    }
    // checks if any cookie is expired
    const currentTimestamp = Date.now() / 1000;
    for (const cookie of cookies) {
        if (cookie.expires < currentTimestamp) {
            return false;
        }
    }
    return true;
}

async function requestLogin() {
    let loginInfo = [];
    const schema = {
        properties: {
            gmail: {
                description: 'please enter your Gmail username ',
                pattern: /^[a-z0-9](\.?[a-z0-9]){5,}@([\w-]*)\.com$/,
                message: 'Gmail username must end in @[domain].com',
                required: true
            },
            pass: {
                description: 'please enter your Gmail password (not saved) ',
                hidden: true
            }
        }
    };

    if (process.env.GMAIL === "" || process.env.PASSWORD === "") {
        // start the prompt
        prompt.start();

        // get login credentials from user, not hardcoded in .env file
        loginInfo = await prompt.get(schema);
        console.log('login credentials received...');
        await sleep(3000);

        // this does not save user input to the .env file, it is only stored for the current execution
        if (loginInfo != undefined) {
            process.env.GMAIL = loginInfo.gmail;
            process.env.PASSWORD = loginInfo.pass;
        }
    }
}

/** 
 * sleep function 
 * @param {int} milliseconds the number of milliseconds the script will pause for
 * @returns {Promise} the response of setTimeout
 */
function sleep(milliseconds) {
    return new Promise((r) => setTimeout(r, milliseconds));
}

// function createDatabase() {
//     //create JSON file if it does not exist
//     mutex.runExclusive(async () => {
//         try {
//             const json = await fs.readFile("./database.json");
//             if (json.toString() === "") {
//                 throw new Error("File is empty.");
//             }
//         } catch {
//             await fs.appendFile("./database.json", JSON.stringify({"sessions": []}));
//         }
//     });
//     //TODO: create Google Sheet if it does not exist
// }

// function updateDatabase(title, startTime, endTime, meetLink, attendanceLog) {
//     try {
//         createDatabase();
//         console.log("updating database...");
//         //update JSON file
//         mutex.runExclusive(async () => {
//             const sessionData = {
//                 title,
//                 startTime,
//                 endTime,
//                 meetLink,
//                 attendanceLog,
//             };
//             const json = await fs.readFile("./database.json", 'utf-8');
//             const storedData = JSON.parse(json);
//             storedData.sessions.push(sessionData);
//             await fs.writeFile("./database.json", JSON.stringify(storedData));
//         });

//         //update Google Sheet
//         mutex.runExclusive(async () => {
//             await sheets.spreadsheets.values.append({
//                 spreadsheetId,
//                 range: (new Date().toLocaleDateString('en-US'))+"!A:E",
//                 valueInputOption: "USER_ENTERED",
//                 resource: {
//                     values: [
//                         [title,
//                         startTime,
//                         endTime,
//                         meetLink,
//                         attendanceLog]
//                     ]
//                 }
//             })
//         })
//     } catch (e) {
//         console.log(e)
//     }
// }

function createLog(guests) {
    let log = "";
    log += (new Date()).toLocaleTimeString('en-US');
    for (const guest of guests) {
        if (guest.status === PRESENT && guest.name !== "ModernSmart Team") {
            log += "\n ∙ " + guest.name + " ✔️"
        }
    }
    return log;
}

function buildMessage(title, startTime, endTime) {
    let startString = startTime.toLocaleTimeString("en-US");
    let endString = endTime.toLocaleTimeString("en-US");
    let date = startTime.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric'});
    startString = (startString.match(DATE_REGEX))[1] + (startString.match(DATE_REGEX))[2].toLowerCase();
    endString = (endString.match(DATE_REGEX))[1] + (endString.match(DATE_REGEX))[2].toLowerCase();
    const text = `${title} ${date}⋅${startString} - ${endString}`;
    return text;
}

async function getThread(text) {
    const thread = await mutex.runExclusive(async () => {
        try {
            return await findMessage(CHANNEL_ID, text);
        } catch {
            return await publishMessage(CHANNEL_ID, text);
        }
    });
    return thread;
}

function sendMessage(thread, log) {  
    mutex.runExclusive(async () => {
        try {
            await replyMessage(CHANNEL_ID, thread.ts, log);
            console.log("message sent!")
        } catch (e) {
            console.log(e);
        }
    });
}

async function createBrowser() {
    // create browser dummy
    const option = {
        revision: "",
        detectionPath: "",
        folderName: ".chromium-browser-snapshots",
        defaultHosts: ["https://storage.googleapis.com", "https://npm.taobao.org/mirrors"],
        hosts: [],
        cacheRevisions: 2,
        retry: 3,
        silent: false
    };
    const stats = await PCR(option);

    puppeteerExtra.use(stealthPlugin());
    const browser = await puppeteerExtra.launch({
        headless: false, // set to false when testing
        executablePath: stats.executablePath,
        args: [
            '--no-sandbox',
            '--use-fake-ui-for-media-stream', //https://stackoverflow.com/questions/48264537/auto-allow-webcam-access-using-puppeteer-for-node-js
        ]
    });
    return browser;
}

export async function main() {
    // asks for login info if .env is not populated
    await requestLogin();
    // creates browser instance used by contexts
    const browser = await createBrowser();
    
    // interval in which event data is being gathered
    const interval = 1 * 60 * 60 * 1000;
    const startRange = Date.now() + (1 * 1000);
    // change to desired end date
    const endRange = (new Date("1/01/2025, 12:00:00 AM")).getTime();
    
    // creates triggers for when events are pulled from monitoring calendar
    const execTriggers = [];
    let timeMin = startRange;
    let timeMax = Math.min(timeMin + interval - 1, endRange - 1);
    while (timeMax < endRange) {
        const minDate = new Date(timeMin);
        const maxDate = new Date(timeMax);
        execTriggers.push(() => {schedule.scheduleJob(minDate, async () => {
            // gets events from calendar
            const events = await getEventData(minDate, maxDate);
            console.log(minDate.toLocaleString('en-US'), maxDate.toLocaleString('en-US'));
        
            // creates triggers for each session to be monitored
            const botTriggers = [];
            const size = events.length;
            for (let i = 0; i < size; i++) {
                const startTime = events[i].startTime;
                if (startTime > minDate && startTime < maxDate) {
                    console.log(events[i].title);
                    // execute trigger 5 minutes before session start time OR immediately (greater of the two)
                    const timeBefore = Math.max(startTime.getTime() - (5 * 60 * 1000), Date.now() + (1 * 1000));
                    const dateBefore = new Date(timeBefore);
                    botTriggers.push(() => {schedule.scheduleJob(dateBefore, async () => {
                        const attendanceLog = await monitorMeet(
                            browser,
                            events[i],
                        );
                    })});
                }
            }
            console.log(botTriggers.length);
            try {
                await pAll(botTriggers, {stopOnError: false});
            } catch (e) {
                console.log(e);
            }
        })});
        timeMin = timeMax + 1;
        timeMax = Math.min(timeMin + interval - 1, endRange);
    }
    console.log(execTriggers.length);
    try {
        await pAll(execTriggers, {stopOnError: false});
    } catch (e) {
        console.log(e);
    }
}
main();

