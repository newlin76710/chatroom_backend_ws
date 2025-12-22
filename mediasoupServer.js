import mediasoup from "mediasoup";
async function getPublicIp() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    return data.ip; // 公網 IP
  } catch (err) {
    console.error("Failed to get public IP, fallback to 127.0.0.1", err);
    return "127.0.0.1";
  }
}
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
  const publicIp = await getPublicIp();
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: "0.0.0.0", announcedIp: publicIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
  return transport;
}
