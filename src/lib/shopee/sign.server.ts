/**
 * Shopee Open API helpers (server-only).
 * Assinatura HMAC-SHA256 conforme spec da Shopee Open Platform v2.
 */
import { createHmac } from "crypto";

export function shopeeHost(): string {
  const env = process.env.SHOPEE_ENV ?? "sandbox";
  return env === "live"
    ? "https://partner.shopeemobile.com"
    : "https://partner.test-stable.shopeemobile.com";
}

export function shopeePartnerId(): number {
  const id = process.env.SHOPEE_PARTNER_ID;
  if (!id) throw new Error("SHOPEE_PARTNER_ID não configurado");
  return Number(id);
}

export function shopeePartnerKey(): string {
  const key = process.env.SHOPEE_PARTNER_KEY;
  if (!key) throw new Error("SHOPEE_PARTNER_KEY não configurado");
  return key;
}

/** Assinatura para endpoints públicos (auth/token): partner_id + path + timestamp */
export function signPublic(path: string, timestamp: number): string {
  const base = `${shopeePartnerId()}${path}${timestamp}`;
  return createHmac("sha256", shopeePartnerKey()).update(base).digest("hex");
}

/** Assinatura para endpoints de shop: partner_id + path + timestamp + access_token + shop_id */
export function signShop(
  path: string,
  timestamp: number,
  accessToken: string,
  shopId: number
): string {
  const base = `${shopeePartnerId()}${path}${timestamp}${accessToken}${shopId}`;
  return createHmac("sha256", shopeePartnerKey()).update(base).digest("hex");
}

/** Constrói a URL de autorização que o vendedor abre para conectar a loja */
export function buildAuthUrl(redirectUrl: string): string {
  const path = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPublic(path, timestamp);
  const partnerId = shopeePartnerId();
  const url = new URL(shopeeHost() + path);
  url.searchParams.set("partner_id", String(partnerId));
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  url.searchParams.set("redirect", redirectUrl);
  return url.toString();
}
