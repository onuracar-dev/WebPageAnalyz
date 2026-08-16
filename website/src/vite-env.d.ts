/// <reference types="vite/client" />

// Better Auth publishes optional Bun/Cloudflare adapter types from its shared
// init surface. This browser-only package does not ship either runtime, so the
// minimal ambient shapes keep strict checking focused on the client contract.
declare module 'bun:sqlite' {
  export class Database {}
}

declare module '@cloudflare/workers-types' {
  export interface D1Database {}
}

type Timer = ReturnType<typeof setTimeout>;
