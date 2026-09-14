import {
  buildImageProxyPath,
  signImageObject,
  verifyImageObject,
} from '../image-proxy-url';

const SECRET = 'un-secreto-de-servidor-suficientemente-largo';
const OBJECT = 'inventory_items/42/10472-8a081fee8b87da44.jpg';
const NOW = 1_700_000_000_000;

describe('image-proxy-url', () => {
  describe('signImageObject', () => {
    it('es determinista para el mismo objeto/exp/secreto', () => {
      const a = signImageObject(OBJECT, NOW, SECRET);
      const b = signImageObject(OBJECT, NOW, SECRET);
      expect(a).toBe(b);
      expect(a.length).toBeGreaterThan(0);
    });

    it('cambia si cambia el objeto, el exp o el secreto', () => {
      const base = signImageObject(OBJECT, NOW, SECRET);
      expect(signImageObject(`${OBJECT}x`, NOW, SECRET)).not.toBe(base);
      expect(signImageObject(OBJECT, NOW + 1, SECRET)).not.toBe(base);
      expect(signImageObject(OBJECT, NOW, `${SECRET}x`)).not.toBe(base);
    });
  });

  describe('buildImageProxyPath', () => {
    it('arma la ruta relativa con o/e/s url-encoded', () => {
      const path = buildImageProxyPath(OBJECT, NOW, 'sig+/=');
      expect(path.startsWith('/product-images/serve?')).toBe(true);
      const qs = new URLSearchParams(path.split('?')[1]);
      expect(qs.get('o')).toBe(OBJECT);
      expect(qs.get('e')).toBe(String(NOW));
      expect(qs.get('s')).toBe('sig+/=');
    });
  });

  describe('verifyImageObject', () => {
    function validSig(exp = NOW + 10_000): string {
      return signImageObject(OBJECT, exp, SECRET);
    }

    it('acepta una firma válida no vencida', () => {
      const exp = NOW + 10_000;
      const res = verifyImageObject({
        objectName: OBJECT,
        expiresAtMs: exp,
        signature: validSig(exp),
        secret: SECRET,
        nowMs: NOW,
      });
      expect(res.ok).toBe(true);
    });

    it('rechaza firma manipulada (bad_signature)', () => {
      const res = verifyImageObject({
        objectName: OBJECT,
        expiresAtMs: NOW + 10_000,
        signature: 'firma-falsa',
        secret: SECRET,
        nowMs: NOW,
      });
      expect(res).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rechaza si el objeto no coincide con el firmado', () => {
      const exp = NOW + 10_000;
      const res = verifyImageObject({
        objectName: 'inventory_items/42/otro-9999.jpg',
        expiresAtMs: exp,
        signature: validSig(exp),
        secret: SECRET,
        nowMs: NOW,
      });
      expect(res.reason).toBe('bad_signature');
    });

    it('rechaza una firma vencida (expired), aun siendo válida', () => {
      const exp = NOW - 1;
      const res = verifyImageObject({
        objectName: OBJECT,
        expiresAtMs: exp,
        signature: signImageObject(OBJECT, exp, SECRET),
        secret: SECRET,
        nowMs: NOW,
      });
      expect(res).toEqual({ ok: false, reason: 'expired' });
    });

    it('rechaza entradas malformadas', () => {
      expect(
        verifyImageObject({
          objectName: '',
          expiresAtMs: NOW,
          signature: 'x',
          secret: SECRET,
          nowMs: NOW,
        }).reason,
      ).toBe('malformed');
      expect(
        verifyImageObject({
          objectName: OBJECT,
          expiresAtMs: NaN,
          signature: 'x',
          secret: SECRET,
          nowMs: NOW,
        }).reason,
      ).toBe('malformed');
    });

    it('un secreto distinto no valida (aislamiento del secreto)', () => {
      const exp = NOW + 10_000;
      const res = verifyImageObject({
        objectName: OBJECT,
        expiresAtMs: exp,
        signature: validSig(exp),
        secret: 'otro-secreto',
        nowMs: NOW,
      });
      expect(res.reason).toBe('bad_signature');
    });
  });
});
