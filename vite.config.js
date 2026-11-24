import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    base: "./",
    server: {
      proxy: {
        "/api": { target: "http://127.0.0.1:" + (Number(env.PORT) || 8787) },
      },
    },
  };
});
