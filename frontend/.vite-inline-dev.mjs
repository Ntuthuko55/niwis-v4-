import { createServer } from "vite";
import config from "./vite.config.js";

const server = await createServer({
  ...config,
  configFile: false,
  root: process.cwd(),
  server: {
    ...config.server,
    host: "127.0.0.1",
    port: 5173,
  },
});

await server.listen();
server.printUrls();
