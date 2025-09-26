import { verifyEvent, type Event } from "nostr-tools/pure";

type Env = {
  LISTENTER: DurableObjectNamespace;
};

export default {
  async fetch(request: Request, env: Env) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
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
    const [client, server] = Object.values(webSocketPair);
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
    socket.addEventListener('message', event => {
      this.#handleIncomingMessage(socket, event).catch((err) => {
        console.error('Failed to handle message', err);
        socket.send(JSON.stringify(["NOTICE", "internal error"]));
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
      socket.send(JSON.stringify(["NOTICE", "expected text frame"]));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch (_err) {
      socket.send(JSON.stringify(["NOTICE", "invalid json"]));
      return;
    }

    if (!Array.isArray(payload) || payload.length === 0) {
      socket.send(JSON.stringify(["NOTICE", "invalid nostr message"]));
      return;
    }

    const [messageType, ...rest] = payload;

    if (messageType !== 'EVENT') {
      socket.send(JSON.stringify(["NOTICE", "write-only relay accepts EVENT messages only"]));
      return;
    }

    const [eventObject] = rest;
    if (!eventObject || typeof eventObject !== 'object') {
      socket.send(JSON.stringify(["NOTICE", "event payload missing"]));
      return;
    }

    const nostrEvent = eventObject as Event;

    if (typeof nostrEvent.kind !== 'number' || !nostrEvent.id) {
      socket.send(JSON.stringify(["NOTICE", "event missing id or kind"]));
      return;
    }

    if (!nostrEvent.pubkey || !nostrEvent.sig || typeof nostrEvent.created_at !== 'number') {
      socket.send(JSON.stringify(["NOTICE", "event missing required fields"]));
      return;
    }

    if (nostrEvent.kind !== 1) {
      socket.send(JSON.stringify(["OK", nostrEvent.id, false, "only kind 1 accepted"]));
      return;
    }

    await this.#storeAcceptedEvent(nostrEvent);
    socket.send(JSON.stringify(["OK", nostrEvent.id, true, ""]));
  }

  async #storeAcceptedEvent(event: Event) {
    if (!verifyEvent(event)) return;
    const total: string[] = (await this.state.storage.get('event-list')) ?? [];
    await this.state.storage.put('event-list', [...total, event.content]);
    console.log(total);
  }
}
