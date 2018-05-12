/*!
 * Reconnecting WebSocket
 * by Pedro Ladaria <pedro.ladaria@gmail.com>
 * https://github.com/pladaria/reconnecting-websocket
 * License MIT
 */

const getGlobalWebSocket = (): WebSocket | undefined => {
    // browser
    if (typeof window !== 'undefined') {
        // @ts-ignore
        return window.WebSocket;
    }
    // node.js / react native
    if (typeof global !== 'undefined') {
        // @ts-ignore
        return global.WebSocket;
    }
    throw Error('Unknown environment');
};

/**
 * Returns true if given argument looks like a WebSocket class
 */
const isWebSocket = (w: any) => typeof w === 'function' && w.CLOSING === 2;

export type Options = {
    WebSocket?: any;
    maxReconnectionDelay?: number;
    minReconnectionDelay?: number;
    minUptime?: number;
    reconnectionDelayGrowFactor?: number;
    connectionTimeout?: number;
    maxRetries?: number;
    debug?: boolean;
};

const DEFAULT = {
    maxReconnectionDelay: 10000,
    minReconnectionDelay: 1000 + Math.random() * 4000,
    minUptime: 5000,
    reconnectionDelayGrowFactor: 1.3,
    connectionTimeout: 4000,
    maxRetries: Infinity,
    debug: false,
};

export type UrlProvider = string | (() => string) | (() => Promise<string>);

export default class ReconnectingWebSocket {
    private _ws: WebSocket | undefined;
    private _listeners: {[type: string]: EventListener[]} = {};
    private _retryCount = 0;
    private _uptimeTimeout: any;
    private _connectTimeout: any;

    private readonly _url: UrlProvider;
    private readonly _protocols: string | string[] | undefined;
    private readonly _options: Options;

    private readonly eventToHandler = new Map<keyof WebSocketEventMap, any>([
        ['open', this._handleOpen],
        ['close', this._handleClose],
        ['error', this._handleError],
        ['message', this._handleMessage],
    ]);

    constructor(
        url: UrlProvider,
        protocols: string | string[] | undefined,
        options: Options,
    ) {
        this._url = url;
        this._protocols = protocols;
        this._options = options;
        this._connect();
        for (const [name] of this.eventToHandler) {
            this._listeners[name] = [];
        }
    }

    static get CONNECTING() {
        return 0;
    }
    static get OPEN() {
        return 1;
    }
    static get CLOSING() {
        return 2;
    }
    static get CLOSED() {
        return 3;
    }

    get CONNECTING() {
        return ReconnectingWebSocket.CONNECTING;
    }
    get OPEN() {
        return ReconnectingWebSocket.OPEN;
    }
    get CLOSING() {
        return ReconnectingWebSocket.CLOSING;
    }
    get CLOSED() {
        return ReconnectingWebSocket.CLOSED;
    }

    /**
     * The number of bytes of data that have been queued using calls to send() but not yet
     * transmitted to the network. This value resets to zero once all queued data has been sent.
     * This value does not reset to zero when the connection is closed; if you keep calling send(),
     * this will continue to climb. Read only
     */
    get bufferedAmount(): number {
        return this._ws ? this._ws.bufferedAmount : 0;
    }

    /**
     * The extensions selected by the server. This is currently only the empty string or a list of
     * extensions as negotiated by the connection
     */
    get extensions(): string {
        return this._ws ? this._ws.extensions : '';
    }

    /**
     * A string indicating the name of the sub-protocol the server selected;
     * this will be one of the strings specified in the protocols parameter when creating the
     * WebSocket object
     */
    get protocol(): string {
        return this._ws ? this._ws.protocol : '';
    }

    /**
     * The current state of the connection; this is one of the Ready state constants
     */
    get readyState(): number {
        return this._ws
            ? this._ws.readyState
            : ReconnectingWebSocket.CONNECTING;
    }

    /**
     * The URL as resolved by the constructor
     */
    get url(): string {
        return this._ws ? this._ws.url : '';
    }

    /**
     * An event listener to be called when the WebSocket connection's readyState changes to CLOSED
     */
    public onclose = (event: CloseEvent) => undefined;

    /**
     * An event listener to be called when an error occurs
     */
    public onerror = (event: Event) => undefined;

    /**
     * An event listener to be called when a message is received from the server
     */
    public onmessage = (event: MessageEvent) => undefined;

    /**
     * An event listener to be called when the WebSocket connection's readyState changes to OPEN;
     * this indicates that the connection is ready to send and receive data
     */
    public onopen = (event: Event) => undefined;

    /**
     * Closes the WebSocket connection or connection attempt, if any. If the connection is already
     * CLOSED, this method does nothing
     */
    public close(code?: number, reason?: string): void {
        // todo
    }

    /**
     * Enqueues the specified data to be transmitted to the server over the WebSocket connection
     */
    public send(data: string | ArrayBuffer | Blob | ArrayBufferView): void {
        if (this._ws) {
            this._ws.send(data);
        }
    }

    /**
     * Register an event handler of a specific event type
     */
    public addEventListener<K extends keyof WebSocketEventMap>(
        type: K,
        listener: EventListener,
    ) {
        this._listeners[type] = this._listeners[type] || [];
        this._listeners[type].push(listener);
    }

    /**
     * Removes an event listener
     */
    public removeEventListener<K extends keyof WebSocketEventMap>(
        type: K,
        listener: EventListener,
    ) {
        if (this._listeners[type]) {
            this._listeners[type] = this._listeners[type].filter(
                l => l !== listener,
            );
        }
    }

    private _debug(...params: any[]) {
        if (this._options.debug) {
            // tslint:disable-next-line
            console.log('RWS>', ...params);
        }
    }

    private _getNextDelay() {
        let delay = 0;
        if (this._retryCount > 0) {
            const {
                reconnectionDelayGrowFactor = DEFAULT.reconnectionDelayGrowFactor,
                minReconnectionDelay = DEFAULT.minReconnectionDelay,
                maxReconnectionDelay = DEFAULT.maxReconnectionDelay,
            } = this._options;

            delay =
                minReconnectionDelay +
                Math.pow(this._retryCount - 1, reconnectionDelayGrowFactor);
            if (delay > maxReconnectionDelay) {
                delay = maxReconnectionDelay;
            }
        }
        this._debug('next delay', delay);
        return delay;
    }

    private _wait(): Promise<void> {
        return new Promise(resolve => {
            setTimeout(resolve, this._getNextDelay());
        });
    }

    /**
     * @return Promise<string>
     */
    private _getNextUrl(urlProvider: UrlProvider): Promise<string> {
        if (typeof urlProvider === 'string') {
            return Promise.resolve(urlProvider);
        }
        if (typeof urlProvider === 'function') {
            const url = urlProvider();
            if (typeof url === 'string') {
                return Promise.resolve(url);
            }
            if (url.then) {
                return url;
            }
        }
        throw Error('Invalid URL');
    }

    private _connect() {
        const {maxRetries = DEFAULT.maxRetries} = this._options;

        if (this._retryCount !== 0 && this._retryCount >= maxRetries) {
            this._debug('max retries reached', maxRetries);
            return;
        }
        this._retryCount++;
        this._debug('connect');
        this._removeListeners();
        const WebSocket = this._options.WebSocket || getGlobalWebSocket();
        if (isWebSocket(WebSocket)) {
            throw Error('No valid WebSocket class provided');
        }
        this._wait()
            .then(() => this._getNextUrl(this._url))
            .then(url => {
                this._debug('connect', {url, protocols: this._protocols});
                this._ws = new WebSocket(url, this._protocols);
                this._addListeners();
            });
    }

    private _disconnect() {
        if (!this._ws) {
            return;
        }
        this._removeListeners();
        this._ws.close();
    }

    private _acceptOpen() {
        this._retryCount = 0;
    }

    private _handleOpen(event: Event) {
        this._debug('open event');
        const {minUptime = DEFAULT.minUptime} = this._options;
        this._uptimeTimeout = setTimeout(this._acceptOpen, minUptime);
        this.onopen(event);
        this._listeners.open.forEach(listener => listener(event));
    }

    private _handleMessage(event: MessageEvent) {
        this._debug('message event');
        this.onmessage(event);
        this._listeners.message.forEach(listener => listener(event));
    }

    private _handleError(event: Event) {
        this._debug('error event');
        this._disconnect();
        this.onerror(event);
        this._listeners.error.forEach(listener => listener(event));
        this._connect();
    }

    private _handleClose(event: CloseEvent) {
        this._debug('close event');
        this.onclose(event);
        this._listeners.close.forEach(listener => listener(event));
    }

    private _removeListeners() {
        if (!this._ws) {
            return;
        }
        this._debug('removeListeners');
        for (const [type, handler] of this.eventToHandler) {
            this._ws.removeEventListener(type, handler);
        }
    }

    private _addListeners() {
        this._debug('assignListeners');
        for (const [type, handler] of this.eventToHandler) {
            this._ws!.addEventListener(type, handler);
        }
    }
}
