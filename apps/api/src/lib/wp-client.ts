import { env } from '../config.js';

export interface WpUserInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  roles: string[];
}

export interface WpClient {
  createUser(input: WpUserInput): Promise<{ id: number }>;
}

// Creates WordPress users via the REST API using an application password.
// Not exercised by the test suite (it talks to a live WP); it is a thin,
// well-scoped adapter behind the WpClient seam.
export class HttpWpClient implements WpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly appPassword: string,
  ) {}

  async createUser(input: WpUserInput): Promise<{ id: number }> {
    const auth = Buffer.from(`${this.user}:${this.appPassword}`).toString('base64');
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/wp-json/wp/v2/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify({
        username: input.username,
        email: input.email,
        first_name: input.firstName,
        last_name: input.lastName,
        password: input.password,
        roles: input.roles,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[wp] create user failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { id: number };
    return { id: body.id };
  }
}

// Returns a configured client, or null when WP sync is not configured.
export const getWpClient = (): WpClient | null => {
  if (!env.WP_BASE_URL || !env.WP_SYNC_USER || !env.WP_SYNC_APP_PASSWORD) return null;
  return new HttpWpClient(env.WP_BASE_URL, env.WP_SYNC_USER, env.WP_SYNC_APP_PASSWORD);
};
