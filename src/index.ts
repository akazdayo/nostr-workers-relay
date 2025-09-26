import { verifyEvent, type Event } from "nostr-tools/pure";

type Env = {
  LISTENTER: DurableObjectNamespace;
};

export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const obj = env.LISTENTER.get(env.LISTENTER.idFromName("test"));
    return obj.fetch(request);
  }
}

export class Listener implements DurableObject {
  constructor(public state: DurableObjectState, public env: Env) { }
  async fetch(request: Request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair) as [WebSocket, WebSocket];
    const acceptedProtocol = this.#acceptWebSocket(server, request);
    this.#handleSession(server);
    const responseInit: ResponseInit = { status: 101, webSocket: client };
    if (acceptedProtocol) {
      responseInit.headers = new Headers({ 'Sec-WebSocket-Protocol': acceptedProtocol });
    }
    return new Response(null, responseInit);
  };

  #acceptWebSocket(socket: WebSocket, request: Request) {
    const protocolHeader = request.headers.get('Sec-WebSocket-Protocol');
    const requestedProtocols = protocolHeader?.split(',').map((p) => p.trim()).filter(Boolean) ?? [];
    const nostrProtocol = requestedProtocols.find((p) => p.toLowerCase() === 'nostr');

    socket.accept();
    return nostrProtocol;
  }

  #handleSession(socket: WebSocket) {
    console.log('Socket connected', socket);

    socket.addEventListener('message', (event) => {
      this.#handleIncomingMessage(socket, event).catch((err) => {
        console.error('Failed to handle message', err);
        this.#sendNotice(socket, 'internal error');
      });
    });
    socket.addEventListener('close', () => {
      console.log('Socket closed');
    });

    socket.addEventListener('error', (event) => {
      console.log('Socket errored', event);
    });
  }

  async #handleIncomingMessage(socket: WebSocket, event: MessageEvent) {
    if (typeof event.data !== 'string') {
      this.#sendNotice(socket, 'expected text frame');
      return;
    }

    const parsed = this.#parseEventMessage(event.data);
    if ('error' in parsed) {
      this.#sendNotice(socket, parsed.error);
      return;
    }

    const nostrEvent = parsed.event;

    if (nostrEvent.kind !== 1) {
      this.#sendOk(socket, nostrEvent.id, false, 'only kind 1 accepted');
      return;
    }

    if (!verifyEvent(nostrEvent)) {
      this.#sendOk(socket, nostrEvent.id, false, 'invalid signature');
      return;
    }

    await this.#storeAcceptedEvent(nostrEvent);
    this.#sendOk(socket, nostrEvent.id, true, '');
  }

  async #storeAcceptedEvent(event: Event) {
    const storedEvents = (await this.state.storage.get<string[]>('event-list')) ?? [];
    storedEvents.push(event.content);
    await this.state.storage.put('event-list', storedEvents);
    console.log('Stored event', event.id);
  }

  #parseEventMessage(raw: string): { event: Event } | { error: string } {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (_err) {
      return { error: 'invalid json' };
    }

    if (!Array.isArray(payload) || payload.length === 0) {
      return { error: 'invalid nostr message' };
    }

    const [messageType, eventPayload] = payload;

    if (messageType !== 'EVENT') {
      return { error: 'write-only relay accepts EVENT messages only' };
    }

    if (!eventPayload || typeof eventPayload !== 'object') {
      return { error: 'event payload missing' };
    }

    const nostrEvent = eventPayload as Partial<Event>;

    if (typeof nostrEvent.kind !== 'number' || typeof nostrEvent.id !== 'string' || !nostrEvent.id) {
      return { error: 'event missing id or kind' };
    }

    if (
      typeof nostrEvent.pubkey !== 'string' ||
      !nostrEvent.pubkey ||
      typeof nostrEvent.sig !== 'string' ||
      !nostrEvent.sig ||
      typeof nostrEvent.created_at !== 'number'
    ) {
      return { error: 'event missing required fields' };
    }

    return { event: nostrEvent as Event };
  }

  #sendNotice(socket: WebSocket, message: string) {
    this.#sendJson(socket, ['NOTICE', message]);
  }

  #sendOk(socket: WebSocket, eventId: string, success: boolean, message: string) {
    this.#sendJson(socket, ['OK', eventId, success, message]);
  }

  #sendJson(socket: WebSocket, payload: unknown[]) {
    socket.send(JSON.stringify(payload));
  }
}
