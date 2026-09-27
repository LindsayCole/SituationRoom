import { cloudflare } from "@cloudflare/vite-plugin";
import { sites } from "@openai/sites-vite-plugin";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };

const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  return {
    plugins: [
      sites(),
      cloudflare({
        config: {
          name: "dead-puck-situation-room",
          main: "./worker/index.ts",
          compatibility_date: "2026-05-22",
          compatibility_flags: ["nodejs_compat"],
          assets: {
            binding: "ASSETS",
            not_found_handling: "single-page-application",
            run_worker_first: ["/*"],
          },
          d1_databases: hostingConfig.d1
            ? [
                {
                  binding: hostingConfig.d1,
                  database_name: "dead-puck-situation-room-local",
                  database_id: LOCAL_DATABASE_ID,
                  migrations_dir: "drizzle",
                },
              ]
            : [],
        },
      }),
    ],
  };
});
