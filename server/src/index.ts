import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { RealHueBridgeManager } from './bridge/realHueBridge.js';
import { type CreateAppOptions, loadConfig } from './config.js';
import { ensureHueCert, type HueCertBundle, regenerateHueCert } from './crypto/hueCert.js';
import { type MdnsService, startMdns } from './discovery/mdns.js';
import { type SsdpService, startSsdp } from './discovery/ssdp.js';
import { EspManager } from './esp32/espManager.js';
import { createEventStreamBroker } from './hue/eventStream.js';
import { createHueV1Router } from './hue/v1Router.js';
import { createHueV2Router } from './hue/v2Router.js';
import { createManagementApi } from './management/apiRouter.js';
import { StateStore } from './store/stateStore.js';

export interface HueBridgeApp {
  store: StateStore;
  espManager: EspManager;
  realHue: RealHueBridgeManager;
  ports: {
    http: number;
    https: number;
    ui: number;
  };
  getCertBundle: () => HueCertBundle;
  close: () => Promise<void>;
}

function listenServer(server: http.Server | https.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address() as AddressInfo | null;
      resolve(addr?.port ?? port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

function closeServer(server: http.Server | https.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

export async function createHueBridgeApp(options: CreateAppOptions = {}): Promise<HueBridgeApp> {
  const cfg = loadConfig(options);
  const store = new StateStore(cfg.dataDir, cfg.bridge);

  let certBundle = ensureHueCert(cfg.certsDir, cfg.bridge.bridgeId, cfg.bridge.ip);
  store.log('info', 'tls', `Loaded Hue P-256 certificate for CN=${certBundle.serialHex}`);

  let mdns: MdnsService | undefined;
  let ssdp: SsdpService | undefined;

  if (cfg.enableDiscovery) {
    mdns = startMdns(store);
    ssdp = startSsdp(store);
  }

  const espManager = new EspManager(store);
  const realHue = new RealHueBridgeManager(store, mdns);
  const eventStream = createEventStreamBroker(store);

  let httpsServer: https.Server | null = null;
  const manageApi = createManagementApi({
    store,
    espManager,
    realHue,
    mdns,
    getCertBundle: () => certBundle,
    onRegenerateCert: () => {
      certBundle = regenerateHueCert(cfg.certsDir, cfg.bridge.bridgeId, cfg.bridge.ip);
      httpsServer?.setSecureContext({
        cert: certBundle.certPem,
        key: certBundle.keyPem,
      });
      store.log('info', 'tls', 'Regenerated Hue Bridge TLS certificate and reloaded HTTPS context');
      return certBundle;
    },
  });

  const hasWebDist = fs.existsSync(path.join(cfg.webDistDir, 'index.html'));

  // Main Hue HTTP/HTTPS Express App
  const hueApp = express();
  hueApp.disable('x-powered-by');
  hueApp.use(cors());

  const onIdentifyLight = (lightId: string) => {
    const light = store.getLight(lightId);
    if (light?.source === 'esp32' && light.espNodeId) {
      espManager.identifyNode(light.espNodeId, light.segmentId);
    }
  };

  hueApp.use(createHueV1Router(store));
  hueApp.use(createHueV2Router(store, eventStream, onIdentifyLight));
  hueApp.use('/manage/api', manageApi.router);

  if (hasWebDist) {
    hueApp.use('/ui', express.static(cfg.webDistDir));
    hueApp.get('/ui/*', (_req, res) => {
      res.sendFile(path.join(cfg.webDistDir, 'index.html'));
    });
    hueApp.get('/', (req, res, next) => {
      if (req.accepts('html')) {
        res.redirect('/ui/');
        return;
      }
      next();
    });
  }

  // Dedicated Management UI Server App
  const uiApp = express();
  uiApp.disable('x-powered-by');
  uiApp.use(cors());
  uiApp.use('/manage/api', manageApi.router);
  if (hasWebDist) {
    uiApp.use(express.static(cfg.webDistDir));
    uiApp.get('*', (_req, res) => {
      res.sendFile(path.join(cfg.webDistDir, 'index.html'));
    });
  } else {
    uiApp.get('/', (_req, res) => {
      res.type('text/plain').send('HueBridge ESP Management API running. Build web/ to serve dashboard.');
    });
  }

  const dispatchUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/ws/esp32') {
      espManager.handleUpgrade(req, socket, head);
    } else if (urlPath === '/ws/ui') {
      manageApi.handleUiUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  };

  const httpServer = http.createServer(hueApp);
  httpServer.on('upgrade', dispatchUpgrade);

  httpsServer = https.createServer(
    {
      cert: certBundle.certPem,
      key: certBundle.keyPem,
    },
    hueApp,
  );
  httpsServer.on('upgrade', dispatchUpgrade);

  const actualHttpPort = await listenServer(httpServer, cfg.bridge.httpPort);
  const actualHttpsPort = await listenServer(httpsServer, cfg.bridge.httpsPort);

  let uiServer: http.Server | null = null;
  let actualUiPort = actualHttpPort;
  if (cfg.bridge.uiPort === 0 || cfg.bridge.uiPort !== cfg.bridge.httpPort) {
    uiServer = http.createServer(uiApp);
    uiServer.on('upgrade', dispatchUpgrade);
    actualUiPort = await listenServer(uiServer, cfg.bridge.uiPort);
  }

  store.setBridgeRuntimeIpAndPorts(
    cfg.bridge.ip,
    actualHttpPort,
    actualHttpsPort,
    actualUiPort,
  );

  store.log(
    'info',
    'server',
    `HueBridge ESP listening: HTTP :${actualHttpPort}, HTTPS :${actualHttpsPort}, UI :${actualUiPort} (IP ${cfg.bridge.ip}, ID ${cfg.bridge.bridgeId})`,
  );

  realHue.startIfConfigured();

  return {
    store,
    espManager,
    realHue,
    ports: {
      http: actualHttpPort,
      https: actualHttpsPort,
      ui: actualUiPort,
    },
    getCertBundle: () => certBundle,
    close: async () => {
      realHue.stop();
      espManager.close();
      eventStream.close();
      manageApi.close();
      await Promise.all([
        mdns?.stop() ?? Promise.resolve(),
        ssdp?.stop() ?? Promise.resolve(),
        closeServer(uiServer),
        closeServer(httpsServer),
        closeServer(httpServer),
      ]);
      store.flush();
    },
  };
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  createHueBridgeApp()
    .then((app) => {
      const b = app.store.getBridgeConfig();
      console.log(
        `[HueBridge ESP] Bridge "${b.name}" (${b.bridgeId}) ready at http://${b.ip}:${app.ports.http} | https://${b.ip}:${app.ports.https} | Dashboard: http://${b.ip}:${app.ports.ui}`,
      );

      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('\n[HueBridge ESP] Shutting down cleanly...');
        await app.close();
        process.exit(0);
      };

      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    })
    .catch((err) => {
      console.error('[HueBridge ESP] Fatal startup error:', err);
      process.exit(1);
    });
}

