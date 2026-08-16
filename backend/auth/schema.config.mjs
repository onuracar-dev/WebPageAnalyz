import { betterAuth } from 'better-auth';
import { organization, twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import pg from 'pg';

const { Pool } = pg;

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/webpage_analyzer' }),
  secret: process.env.BETTER_AUTH_SECRET || 'development-schema-generation-secret-32-chars',
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:5000',
  emailAndPassword: { enabled: true },
  plugins: [organization(), passkey({
    rpID: process.env.ADMIN_WEBAUTHN_RP_ID || 'localhost',
    rpName: process.env.ADMIN_WEBAUTHN_RP_NAME || 'WebPageAnalyzer Admin',
    origin: process.env.APP_URL || 'http://localhost:5173',
  }), twoFactor()],
});
