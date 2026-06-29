import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import 'colors';
import EventsManager from './inc/EventsManager.js';
import express from 'express';
import { Server as WSS } from 'socket.io';
import http from 'http';
import fetch from 'node-fetch';
import bodyParser from "body-parser";
import fs, { promises as fsp } from 'fs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const startings = {};


const app = express();
const server = http.createServer(app);
const io = new WSS(server);

io.on('connection', socket => {
    socket.join('admin');
    socket.on('answer', (id, data) => startings[id].answer(data));
});

app.use(express.static('./publics'));
app.use(bodyParser.json());

server.listen(8080);

app.get('/api/data', async (req, res) => {
    const request = await fetch('https://front.phi-gate.it/api/startings', {
        headers: { 'Authorization': 'Bearer 69a9c6bf-272f-4da0-b283-483e3f4202b1' }
    });
    const response = await request.json();
    res.json(response);
});

app.get('/api/starting', async (req, res) => {
    const { id } = req.query;

    if(!startings[id] && fs.existsSync(path.join(process.cwd(), 'startings', 'TrunkClient', id + '.js')))
        startings[id] = new SophiaProcess(id, path.join(process.cwd(), 'startings', 'TrunkClient', id + '.js'));
    else if(!fs.existsSync(path.join(process.cwd(), 'startings', 'TrunkClient', id + '.js')))
        return res.json({
            ok: false,
            status: 404
        });

    res.json({
        ok: true,
        data: {
            status: startings[id].status,
            currentProcess: startings[id].currentProcess,
            pendingUpdate: startings[id].pendingUpdate,
            reason: startings[id].reason,
            websockets: Object.keys(startings[id].websockets).map(i => ({ name: i, ...startings[id].websockets[i] })),
            accounts: Object.keys(startings[id].accounts).map(i => ({ name: i, ...startings[id].accounts[i] })),
            calls: startings[id].calls,
            logs: startings[id].logs,
            question: startings[id].activeQuestion
        }
    });
});

app.post('/api/starting/:id/start', async (req, res) => {
    const { id } = req.params;
    await startings[id].start();
    res.json({ ok: true });
});

app.post('/api/starting/:id/reinstall', async (req, res) => {
    const { id } = req.params;
    const { licenseKey } = req.body;
    if(startings[id].calls.length){
        startings[id].pendingUpdate = true;
        io.to('admin').emit('update', id, 'pendingUpdate', true);
        return res.status(409).json({ ok: false, status: 409 });
    }
    else{
        startings[id].pendingUpdate = false;
        io.to('admin').emit('update', id, 'pendingUpdate', false);
    }
    await startings[id].kill();
    await fsp.writeFile(path.join(process.cwd(), 'startings', 'TrunkClient', id + '.js'), (await fsp.readFile(path.join(process.cwd(), 'startings', 'TrunkClient', 'front_latest.js'), 'utf-8')).replace('${license_key}', licenseKey));
    await startings[id].start();
    res.json({ ok: true });
});

app.post('/api/starting/:id/stop', async (req, res) => {
    const { id } = req.params;
    await startings[id].kill();
    res.json({ ok: true });
});

app.post('/api/install', async (req, res) => {
    const { id } = req.query;
    const { licenseKey } = req.body;
    if(fs.existsSync('./startings/' + id + '.js'))
        return res.json({
            ok: false,
            status: 409,
            error: 'Installation already done'
        });
    await fsp.writeFile(path.join(process.cwd(), 'startings', 'TrunkClient', id + '.js'), (await fsp.readFile(path.join(process.cwd(), 'startings', 'TrunkClient', 'front_latest.js'), 'utf-8')).replace('${license_key}', licenseKey));
    startings[id] = new SophiaProcess(id, path.join(process.cwd(), 'startings', 'TrunkClient', id + '.js'));
    res.json({ ok: true });
});

app.get('/api/starting/:id/savedQuestion', (req, res) => {
    const { id } = req.params;
    res.json({ ok: true, data: startings[id]?.savedQuestions });
});

app.delete('/api/starting/:id/savedQuestion', (req, res) => {
    const { id } = req.params;
    const { question } = req.query;
    startings[id].save(question, '');
    res.json({ ok: true, data: startings[id]?.savedQuestions });
});

app.post('/api/starting/:id/saveQuestion', (req, res) => {
    const { id } = req.params;
    const { answer, question } = req.body;
    startings[id].save(question, answer);
    res.json({ ok: true, data: startings[id]?.savedQuestions });
});

const cleanDotsEnd = s => s.replace(/\.{1,}$/, "");

class SophiaProcess extends EventsManager{
    #status = 'stopped';
    #script;
    #reason;
    #currentProcess;
    #child;
    #question;
    #websockets = {};
    #accounts = {};
    #logs = [];
    #calls = [];
    #savedQuestions = {}
    #temp;

    get calls(){ return this.#calls }
    get logs(){ return this.#logs }
    get savedQuestions(){ return this.#savedQuestions }
    get activeQuestion(){ return this.#question }

    log(type, message){
        this.trigger('log', { date: new Date(), type, message });
        this.#logs.push({ date: new Date(), type, message });
    }

    save(question, answer){
        if(answer === '')
            return delete this.#savedQuestions[question];
        this.#savedQuestions[question] = answer
    }

    constructor(id, script){
        super();
        this.id = id;
        this.#script = script;

        let online;
        this.on('status', data => {
            if(data === 'stopped' || data === 'killed')
                online = false;
            if(data === 'online')
                online = true;
            io.to('admin').emit('update', this.id, 'status', data);
        });

        this.on('call:incoming:start', data => io.to('admin').emit('update', this.id, 'call:incoming:start', data));
        this.on('call:incoming:end', data => io.to('admin').emit('update', this.id, 'call:incoming:end', data));
        this.on('log', data => io.to('admin').emit('log', this.id, data));
        this.on('block:executing', data => io.to('admin').emit('update', this.id, 'block:executing', data));

        this.on('currentProcess', async data => {
            if(data === 'Recupero il flusso' && online){
                await this.kill();
                this.start();
            }
            
            io.to('admin').emit('update', this.id, 'currentProcess', data);
        });

        this.on('websocket:log', object => {
            const { type, data, target } = object;
            io.to('admin').emit('update', this.id, 'websocket:log', { type, data, target });
        });

        this.on('crashed', data => {
            if(!this.#killing)
                io.to('admin').emit('update', this.id, 'account:log', data);
        });

        this.on('account:log', object => {
            const { type, data, target } = object;
            io.to('admin').emit('update', this.id, 'account:log', { type, data, target });
        });

        this.on('question', (question, options) => {
            if(this.#savedQuestions[question])
                this.answer(this.#savedQuestions[question]);
            else io.to('admin').emit('update', this.id, 'question', { question, options });
        });

        this.on('crashed', async data => {
            console.log(data)
            await delay(2000);
            if(!data && !this.#killing)
                this.start();
            io.to('admin').emit(this.id, data);
        });
    }

    question(question, options){
        this.#question = { question, options };
        this.trigger('question', question, options);
    }

    #killing = false;

    kill(timeoutMs = 3000){
        this.#websockets = {};
        this.#accounts = {};
        this.#calls = [];
        const child = this.#child;
        this.#killing = true;

        if(!child || !child.pid){
            this.status = 'stopped';
            return Promise.resolve({ alreadyClosed: true });
        }

        const isRunning = () => {
            try { process.kill(child.pid, 0); return true; }
            catch { return false; }
        };

        this.status = 'stopped';

        return new Promise((resolve) => {
            let settled = false;

            const cleanup = () => {
                child.removeListener("exit", onExit);
                child.removeListener("close", onClose);
                child.removeListener("error", onError);
            };

            const settle = (result) => {
                if(settled) return;
                settled = true;
                cleanup();
                resolve(result);
            };

            const onExit = (code, signal) => settle({ closed: true, via: "exit", code, signal });
            const onClose = (code, signal) => settle({ closed: true, via: "close", code, signal });
            const onError = (error) => settle({ closed: false, via: "error", error });

            child.once("exit", onExit);
            child.once("close", onClose);
            child.once("error", onError);

            try { child.kill("SIGTERM"); } catch {}

            setTimeout(() => {
                if(settled) return;

                if(isRunning()){
                    this.status = 'killed';
                    try { child.kill("SIGKILL"); } catch {}
                }
                else
                    settle({ closed: true, via: "poll", forced: false });
            }, timeoutMs);

            const poll = setInterval(() => {
                if(settled) return clearInterval(poll);
                if(!isRunning()){
                    clearInterval(poll);
                    settle({ closed: true, via: "poll", forced: this.status === "killed" });
                }
            }, 150);
        });
    }

    answer(text){
        this.#question = null;
        this.#child.stdin.write(text + '\r\n');
    }

    #processLine(string){
        const runningPrefix = '[' + 'RUNNING'.cyan.bold +  ']';
        const successPrefix = '[' + 'SUCCESS'.brightGreen.bold +  ']';
        const errorPrefix = '[' + 'ERROR'.brightRed.bold +  ']';
        const warningPrefix = '[' + 'WARNING'.yellow.bold +  ']';
        const dangerPrefix = '[' + 'DANGER'.bgRed.white.bold +  ']';
        const logPrefix = '[' + 'LOG'.gray.bold +  ']';
        if(string.includes('PROCESS DURATION')){
            // Loading end
            this.status = 'sleeping';
            return;
        }
        else if(string.includes("Sono stati trovati più account Meta, seleziona quello corretto:"))
            return this.#temp = { type: 'meta-accounts', options: {} };
        else if(string.includes("Desideri salvare l'opzione selezionata?"))
            return this.answer('n');
        else if(string.startsWith(logPrefix)){
            this.log('log', string);
            string = cleanDotsEnd(string);
            string = string.substring(logPrefix.length + 1);
            const ending = string.startsWith('Chiamata in ingresso terminata ');
            if(string.startsWith('Chiamata in ingresso ') || ending){
                string = string.substring(ending ? 31 : 21).split('-------------');
                const [ callId, client, number ] = string;
                if(!ending){
                    this.trigger('call:incoming:start', { callId, client, number });
                    this.#calls.push({ type: 'incoming', callId, client, number });
                }
                else{
                    this.trigger('call:incoming:end', { callId, client, number });
                    this.#calls.splice(this.#calls.indexOf(this.#calls.find(i => i.type === 'incoming' && i.callId === callId)), 1);
                }
            }
            else if(string.startsWith('EXECUTING')){
                const [ _, callId, block ] = string.split(' ');
                this.trigger('block:executing', { block, callId });
            }
            return;
        }
        else if(string.includes('Inserisci il numero dell\'account corretto:')){
            this.question(this.#temp.type, this.#temp.options);
            return this.#temp = undefined;
        }
        else if(this.#temp?.type === 'meta-accounts' && string)
            return this.#temp.options[Object.values(this.#temp.options).length + 1] = string.split(' ').slice(1).join(' ');
        else if(string === '.'){
            this.status = 'loading';
            return;
        }
        else if(string.startsWith(runningPrefix)){
            string = cleanDotsEnd(string);
            string = string.substring(runningPrefix.length + 1);
            this.log('running', string);
            this.currentProcess = string;
            return;
        }
        else if(string.startsWith(successPrefix)){
            string = cleanDotsEnd(string);
            string = string.substring(successPrefix.length + 1);
            this.log('success', string);
            if(string.startsWith('Connesso al WebSocket')){
                string = string.substring(23, string.length - 1);
                let object = this.#websockets[string];
                if(!object)
                    object = (this.#websockets[string] = {});
                object.status = 'connected';
                if(!object.log)
                    object.log = [];
                object.log.push({ date: new Date(), command: 'connected' });
                return this.trigger('websocket:log', {
                    type: 'event',
                    data: 'connected',
                    target: string
                });
            }
            else if(string.startsWith('Interno \"')){
                string = string.substring(9).split('"')[0];
                if(!this.#accounts[string])
                    this.#accounts[string] = {};
                this.#accounts[string].status = 'registered';
                if(!this.#accounts[string].log)
                    this.#accounts[string].log = [];
                this.#accounts[string].log.push({ date: new Date(), command: 'registered' });
                return this.trigger('account:log', {
                    type: 'event',
                    data: 'registered',
                    target: string
                });
            }
            else if(string === 'Processo avviato')
                return this.status = 'online';
            
            this.log('success', string);
        }
        else if(string.startsWith(errorPrefix)){
            string = cleanDotsEnd(string);
            string = string.substring(errorPrefix.length + 1);
            this.log('error', string);
            if(string.startsWith('Connessione al WebSocket')){
                string = string.substring(26, string.length - 14);
                let object = this.#websockets[string];
                if(!object)
                    object = (this.#websockets[string] = {});
                object.status = 'disconnected';
                if(!object.log)
                    object.log = [];
                object.log.push({ date: new Date(), command: 'disconnected' });
                return this.trigger('websocket:log', {
                    type: 'event',
                    data: 'disconnected',
                    target: string
                });
            }
            else if(string.startsWith('Impossibile registrare l\'interno "')){
                string = string.substring(34).split('"')[0];
                if(!this.#accounts[string])
                    this.#accounts[string] = {};
                this.#accounts[string].status = 'error';
                if(!this.#accounts[string].log)
                    this.#accounts[string].log = [];
                this.#accounts[string].log.push({ date: new Date(), command: 'error' });
                return this.trigger('account:log', {
                    type: 'event',
                    data: 'error',
                    target: string
                });
            }
        }
        else if(string.startsWith(warningPrefix)){
            string = cleanDotsEnd(string);
            string = string.substring(warningPrefix.length + 1);
            this.log('warning', string);
            if(string.startsWith('Connessione all\'account "')){
                string = string.substring(25).split('"')[0];
                if(!this.#accounts[string])
                    this.#accounts[string] = {};
                this.#accounts[string].status = 'disabled';
                if(!this.#accounts[string].log)
                    this.#accounts[string].log = [];
                this.#accounts[string].log.push({ date: new Date(), command: 'disabled' });
                return this.trigger('account:log', {
                    type: 'event',
                    data: 'disabled',
                    target: string
                });
            }
            else if(string.startsWith('Request error'))
                return this.trigger('error', {
                    type: 'http-request-error',
                    method: string.substring(14).split(' ')[0],
                    url: string.substring(14).split(' ').slice(1).join(' ')
                });
        }
        else if(string.startsWith(dangerPrefix)){
            string = cleanDotsEnd(string);
            string = string.substring(dangerPrefix.length + 1);
            this.status = 'crashed';
            this.log('danger', string);
            return this.#reason = ({
                'Licenza non valida': 'invalid-license',
                'Il server non ha restituito un flusso valido': 'invalid-flow',
                'Il server non ha restituito una risposta valida': 'invalid-response'
            })[string];
        }
        else this.log('log', string);
    }

    async start(){
        this.#websockets = {};
        this.#accounts = {};
        this.#calls = [];
        const child = spawn('node', [ path.basename(this.#script) ], { cwd: path.dirname(this.#script), shell: false });
        child.stdout.on("data", string => {
            string = string.toString().trim().split('\n').map(i => i.trim());
            string.forEach(line => this.#processLine(line));
        });
        child.on("error", console.error);
        child.on("close", () => this.trigger('crashed', this.reason));
        this.#child = child;
    }

    set status(value){
        if(value !== this.#status)
            this.trigger('status', value);
        this.#status = value;
    }

    set currentProcess(value){
        if(value !== this.#currentProcess)
            this.trigger('currentProcess', value);
        this.#currentProcess = value;
    }

    get reason(){ return this.#reason }
    get status(){ return this.#status }
    get currentProcess(){ return this.#currentProcess }
    get websockets(){ return this.#websockets }
    get accounts(){ return this.#accounts }
}


const LATEST_FILE = path.join(process.cwd(), 'startings', 'TrunkClient', 'front_latest.js');

const debounce = (fn, ms = 300) => {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
};

const broadcastPendingUpdateAll = (reason = 'front_latest.js updated') => {
    const ids = Object.keys(startings);

    console.log('--------------------');
    console.log(`[${new Date().toISOString()}] LATEST WATCH: modifica rilevata (${reason})`);
    console.log(`[${new Date().toISOString()}] LATEST WATCH: startings in memoria: ${ids.length}`);

    for(const id of ids){
        const s = startings[id];
        if(!s) continue;

        s.pendingUpdate = true;
        io.to('admin').emit('update', id, 'pendingUpdate', true);

        console.log(`[${new Date().toISOString()}] pendingUpdate=TRUE -> "${id}" (chiamate attive: ${Array.isArray(s.calls) ? s.calls.length : 0})`);
    }
};

const onLatestChange = debounce((eventType, filename) => {
    broadcastPendingUpdateAll(`${eventType}${filename ? `:${filename}` : ''}`);
}, 250);

try{
    fs.watch(LATEST_FILE, { persistent: true }, onLatestChange);

    console.log('--------------------');
    console.log(`[${new Date().toISOString()}] LATEST WATCH: attivo su ${LATEST_FILE}`);
}
catch(err){
    console.log('--------------------');
    console.log(`[${new Date().toISOString()}] LATEST WATCH: errore attivazione watch su ${LATEST_FILE}`);
    console.error(err);
}

let lastMtime = 0;
setInterval(async () => {
    try{
        const st = await fsp.stat(LATEST_FILE);
        const mtime = st.mtimeMs || +st.mtime;
        if(!lastMtime) lastMtime = mtime;
        if(mtime > lastMtime){
            lastMtime = mtime;
            broadcastPendingUpdateAll('mtime polling');
        }
    }
    catch{}
}, 1000);
