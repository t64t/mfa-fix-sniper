const WebSocket = require('ws');
const http2 = require('http2');
const tls = require('tls');
const fs = require('fs');
const config = require('./config.json');

const state = {
    guilds: new Map(),
    mfaToken: null,
    savedTicket: null,
    lastSequence: null,
    heartbeatInterval: null,
    reconnectTimeout: null
};
const TLS_OPTIONS = {
    rejectUnauthorized: false,
    secureContext: tls.createSecureContext({
        secureProtocol: 'TLSv1_2_method'
    }),
    ALPNProtocols: ['h2']
};

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36',
    'Authorization': config.claimerToken,
    'Content-Type': 'application/json',
    'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InRyLVRSIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzMy4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiJodHRwczovL3d3dy5nb29nbGUuY29tLyIsInJlZmVycmluZ19kb21haW4iOiJ3d3cuZ29vZ2xlLmNvbSIsInNlYXJjaF9lbmdpbmUiOiJnb29nbGUiLCJyZWZlcnJlcl9jdXJyZW50IjoiIiwicmVmZXJyaW5nX2RvbWFpbl9jdXJyZW50IjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzY5NzUxLCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsfQ=='
};

const WS_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Authorization': config.listToken,
    'Content-Type': 'application/json',
    'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJ0ci1UUiIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEzMy4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEzMy4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vIiwicmVmZXJyaW5nX2RvbWFpbiI6Ind3dy5nb29nbGUuY29tIiwic2VhcmNoX2VuZ2luZSI6Imdvb2dsZSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJjYW5hcnkiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTYxNDAsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImhhc19jbGllbnRfbW9kcyI6ZmFsc2V9'
};
function log(message, type = 'INFO') {
    if (type === 'DEBUG') return;
    console.log(`[${type}] ${message}`);
}

class SessionManager {
    constructor() {
        this.session = null;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.requestQueue = [];
        this.createSession();
    }

    createSession() {
        if (this.isConnecting) return;
        this.isConnecting = true;
        
        if (this.session) {
            try { this.session.destroy(); } catch (error) {}
        }
        
        this.session = http2.connect(`https://${config.apiBase}`, {
            ...TLS_OPTIONS,
            settings: { 
                enablePush: false,
                initialWindowSize: 1024 * 1024 * 10,
                maxSessionMemory: 64,
                maxConcurrentStreams: 1000
            }
        });
        
        this.session.on('connect', () => {
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            this.processQueue();
        });
        
        this.session.on('error', () => {
            this.isConnecting = false;
            setTimeout(() => this.createSession(), 500);
        });
        
        this.session.on('close', () => {
            this.isConnecting = false;
            setTimeout(() => this.createSession(), 500);
        });
    }

    processQueue() {
        if (this.requestQueue.length > 0) {
            const requests = [...this.requestQueue];
            this.requestQueue = [];
            requests.forEach(req => this.request(req.method, req.path, req.headers, req.body)
                .then(req.resolve)
                .catch(req.reject));
        }
    }

    async request(method, path, customHeaders = {}, body = null) {
        if (!this.session || this.session.destroyed) {
            return new Promise((resolve, reject) => {
                this.requestQueue.push({
                    method, path, headers: customHeaders, body, resolve, reject
                });
                this.createSession();
            });
        }
        
        const requestHeaders = {
            ...BASE_HEADERS,
            ...customHeaders,
            ":method": method,
            ":path": path,
            ":authority": config.apiBase,
            ":scheme": "https"
        };
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 3000);
            
            try {
                const stream = this.session.request(requestHeaders);
                let data = '';
                
                stream.on("data", chunk => data += chunk);
                stream.on("end", () => {
                    clearTimeout(timeout);
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                });
                
                stream.on("error", () => {
                    clearTimeout(timeout);
                    reject(new Error('Stream error'));
                });
                
                if (body) {
                    stream.end(typeof body === 'string' ? body : JSON.stringify(body));
                } else {
                    stream.end();
                }
            } catch (error) {
                clearTimeout(timeout);
                this.createSession();
                reject(error);
            }
        });
    }
    
    async ping() {
        try {
            await this.request("HEAD", "/");
            return true;
        } catch {
            return false;
        }
    }
}
class MfaManager {
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
        this.mfaToken = null;
        this.lastRefresh = 0;
        this.refreshPromise = null;
    }
    
    async refreshMfaToken() {
        const now = Date.now();
        if (now - this.lastRefresh < 20000 && this.mfaToken) {
            return this.mfaToken;
        }
        
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        
        this.refreshPromise = this._doRefresh();
        const result = await this.refreshPromise;
        this.refreshPromise = null;
        return result;
    }
    
    async _doRefresh() {
        try {
            const initialResponse = await this.sessionManager.request(
                "PATCH", 
                `/api/v10/guilds/${config.guildId}/vanity-url`,
                {},
                { code: "test" + Math.random().toString(36).substring(2, 7) }
            );
            
            if (initialResponse.code === 60003 && initialResponse.mfa && initialResponse.mfa.ticket) {
                state.savedTicket = initialResponse.mfa.ticket;
                
                const mfaEndpoints = [
                    { url: "/api/v9/mfa/finish", data: { ticket: state.savedTicket, mfa_type: "password", data: config.password } },
                    { url: "/api/v9/auth/mfa/password", data: { ticket: state.savedTicket, password: config.password } },
                    { url: "/api/v10/auth/mfa/password", data: { ticket: state.savedTicket, password: config.password } }
                ];
                
                const promises = mfaEndpoints.map(endpoint => 
                    this.sessionManager.request(
                        "POST",
                        endpoint.url,
                        { "Content-Type": "application/json" },
                        endpoint.data
                    ).catch(() => null)
                );
                
                const results = await Promise.all(promises);
                
                for (const response of results) {
                    if (response && response.token) {
                        this.mfaToken = response.token;
                        state.mfaToken = response.token;
                        this.lastRefresh = Date.now();
                        return this.mfaToken;
                    }
                }
            }
        } catch {}
        
        return this.mfaToken;
    }
}
class VanitySniper {
    constructor(sessionManager, mfaManager) {
        this.sessionManager = sessionManager;
        this.mfaManager = mfaManager;
        this.claimAttempts = new Map();
        this.lastClaim = {};
    }
    
    async claimVanity(vanityCode) {
        if (this.claimAttempts.has(vanityCode)) {
            return this.claimAttempts.get(vanityCode);
        }
        
        if (Date.now() - (this.lastClaim[vanityCode] || 0) < 500) {
            return false;
        }
        
        this.lastClaim[vanityCode] = Date.now();
        
        const attemptPromise = this._doClaimVanity(vanityCode);
        this.claimAttempts.set(vanityCode, attemptPromise);
        
        attemptPromise.finally(() => {
            this.claimAttempts.delete(vanityCode);
        });
        
        return attemptPromise;
    }
    
    async _doClaimVanity(vanityCode) {
        try {
            log(`Claiming: ${vanityCode}`, 'ALERT');
            
            const mfaToken = await this.mfaManager.refreshMfaToken();
            
            if (!mfaToken) return false;
            
            const response = await this.sessionManager.request(
                "PATCH",
                `/api/v10/guilds/${config.guildId}/vanity-url`,
                { "X-Discord-MFA-Authorization": mfaToken },
                { code: vanityCode }
            );
            
            if (response.code === vanityCode) {
                log(`URL ÇEKİLDİ.: ${vanityCode}`, 'Telepatia%Morvay');
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }
}
class DiscordGateway {
    constructor(vanitySniper) {
        this.vanitySniper = vanitySniper;
        this.socket = null;
        this.reconnectAttempts = 0;
        this.connect();
    }
    
    connect() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
        
        this.socket = new WebSocket(config.gatewayUrl, {
            handshakeTimeout: 2000,
            perMessageDeflate: false
        });
        
        this.socket.on('open', () => {
            this.reconnectAttempts = 0;
            log("gateway baÄŸlantÄ±sÄ± var", "Telepatia%Morvay");
            
            
            this.socket.send(JSON.stringify({
                op: 2,
                d: {
                    token: config.listToken,
                    intents: 1,
                    properties: {
                        os: "Windows",
                        browser: "Firefox",
                        device: "",
                        system_locale: "tr-TR",
                        browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
                        browser_version: "133.0",
                        os_version: "10",
                        referrer: "https://www.google.com/",
                        referring_domain: "www.google.com",
                        search_engine: "google",
                        referrer_current: "",
                        referring_domain_current: "",
                        release_channel: "canary",
                        client_build_number: 356140,
                        client_event_source: null,
                        has_client_mods: false
                    }
                }
            }));
        });
        
        this.socket.on('message', (data) => {
            try {
                const payload = JSON.parse(data.toString());
                this.handleMessage(payload);
            } catch {}
        });
        
        this.socket.on('close', () => {
            clearInterval(state.heartbeatInterval);
            setTimeout(() => this.connect(), 500);
        });
        
        this.socket.on('error', () => {
            if (this.socket.readyState !== WebSocket.CLOSED) {
                try { this.socket.close(); } catch {}
            }
        });
    }
    
    handleMessage(payload) {
        if (payload.s !== null && payload.s !== undefined) {
            state.lastSequence = payload.s;
        }
        
        switch (payload.op) {
            case 10:
                clearInterval(state.heartbeatInterval);
                
                if (payload.d && payload.d.heartbeat_interval) {
                    state.heartbeatInterval = setInterval(() => {
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                            this.socket.send(JSON.stringify({ op: 1, d: state.lastSequence }));
                        } else {
                            clearInterval(state.heartbeatInterval);
                            this.connect();
                        }
                    }, payload.d.heartbeat_interval);
                }
                break;
                
            case 0:
                if (!payload.t || !payload.d) return;
                
                const { t: type, d: eventData } = payload;
                
                if (type === 'READY') {
                    log("ready hazir", "Telepatia%Morvay");
                    log('Daha hizli sniperler iÃ§in discord.gg/38', 'Ã–nemli');
                    if (eventData.guilds && Array.isArray(eventData.guilds)) {
                        eventData.guilds.forEach(guild => {
                            if (guild && guild.id && guild.vanity_url_code) {
                                state.guilds.set(guild.id, guild.vanity_url_code);
                            }
                        });
                        console.log(state.guilds)
                    }
                }
                else if (type === 'GUILD_UPDATE') {
                    if (!eventData || !eventData.id) return;
                    
                    const oldVanity = state.guilds.get(eventData.id);
                    
                    if (oldVanity && eventData.vanity_url_code !== undefined && oldVanity !== eventData.vanity_url_code) {
                        if (!eventData.vanity_url_code || eventData.vanity_url_code === '') {
                            log(`url: ${oldVanity}`, 'uyari');
                            
                            for (let i = 0; i < 5; i++) {
                                this.vanitySniper.claimVanity(oldVanity);
                            }
                        }
                    }
                    
                    if (eventData.vanity_url_code !== undefined) {
                        state.guilds.set(eventData.id, eventData.vanity_url_code);
                    }
                }
                break;
        }
    }
}
async function main() {
    try {
        process.setMaxListeners(0);
        
        const sessionManager = new SessionManager();
        const mfaManager = new MfaManager(sessionManager);
        const vanitySniper = new VanitySniper(sessionManager, mfaManager);
        const gateway = new DiscordGateway(vanitySniper);
        
        await mfaManager.refreshMfaToken();
        
        setInterval(() => mfaManager.refreshMfaToken(), 25000);
        setInterval(() => sessionManager.ping(), 900000);
        
        process.on('uncaughtException', () => {});
        process.on('unhandledRejection', () => {});
        
        process.on('SIGINT', () => {
            clearInterval(state.heartbeatInterval);
            clearTimeout(state.reconnectTimeout);
            process.exit(0);
        });
        
        log('sniper baslatildi', 'Telepatia%Morvay');
        
    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
    }
}

main();