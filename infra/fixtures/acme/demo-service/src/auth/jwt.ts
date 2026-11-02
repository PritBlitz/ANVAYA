export interface Claims {
  sub: string;
  exp: number;
}

export function verify(token: string): Claims {
  const [sub, exp] = token.split(':');
  return { sub: sub ?? '', exp: Number(exp ?? 0) };
}
