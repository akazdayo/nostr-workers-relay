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
  async fetch(_request: Request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.#handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  };

  #handleSession(socket: WebSocket) {
    console.log('Socket connected', socket);
    socket.accept();
    socket.addEventListener('message', async event => {
      const value: number = await this.state.storage.get("value") || 0;
      await this.state.storage.put("value", value + 1);
      console.log('Socket onmessage', event.data, value);
      return new Response(value.toString());
    });
    socket.addEventListener('close', () => {
      console.log('Socket closed');
    });

    socket.addEventListener('error', (event) => {
      console.log('Socket errored', event);
    });
  }

}