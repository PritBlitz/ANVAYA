import { verify } from './jwt';

export class TokenExpiredError extends Error {}

export class TokenService {
  constructor(private readonly ttlSeconds: number) {}

  /** Refresh an access token using a refresh token. */
  refreshAccessToken(refreshToken: string): string {
    const claims = verify(refreshToken);
    if (claims.exp < Date.now() / 1000) {
      throw new TokenExpiredError('refresh token expired');
    }
    return issueToken(claims.sub, this.ttlSeconds);
  }
}

export function issueToken(sub: string, ttl: number): string {
  return `${sub}:${ttl}`;
}
