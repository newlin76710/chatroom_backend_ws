import mediasoup from "mediasoup";

let worker;
let router;
export const peers = {}; // { socketId: { transports: [], producers: [] } }

export async function initMediasoup() {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({
    mediaCodecs: [
      { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 }
    ]
  });
  console.log("Mediasoup worker & router ready");
}

export function getRouter() {
  return router;
}

export async function createWebRtcTransport() {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
  return transport;
}
