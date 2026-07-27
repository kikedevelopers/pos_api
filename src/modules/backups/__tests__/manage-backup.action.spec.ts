import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ManageBackupAction } from '../actions/manage-backup.action';

const BACKUPS = { bucket: 'my-bucket', prefix: 'backups' };
const VALID = 'placepos-20260727-135405.dump';

function buildAction(options: { exists?: boolean } = {}) {
  const file = {
    exists: jest.fn(() => Promise.resolve([options.exists ?? true])),
    delete: jest.fn(() => Promise.resolve()),
    getSignedUrl: jest.fn((_options: { version: string; action: string; expires: number }) =>
      Promise.resolve(['https://storage.googleapis.com/firmada']),
    ),
  };
  const bucketFile = jest.fn(() => file);
  const storage = { getBucket: () => ({ file: bucketFile }) };
  const configService = { getOrThrow: () => BACKUPS };

  const action = new ManageBackupAction(configService as never, storage as never);
  return { action, file, bucketFile };
}

describe('ManageBackupAction · borrar', () => {
  it('borra el respaldo indicado', async () => {
    const { action, file, bucketFile } = buildAction();

    const result = await action.remove(VALID);

    expect(bucketFile).toHaveBeenCalledWith(`backups/${VALID}`);
    expect(file.delete).toHaveBeenCalled();
    expect(result).toEqual({ deleted: VALID });
  });

  it('404 si el respaldo ya no existe (y no intenta borrarlo)', async () => {
    const { action, file } = buildAction({ exists: false });

    await expect(action.remove(VALID)).rejects.toBeInstanceOf(NotFoundException);
    expect(file.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['../../etc/passwd', 'traversal'],
    ['backups/placepos-20260727-135405.dump', 'ruta con carpeta'],
    ['otro-archivo.dump', 'prefijo distinto'],
    ['placepos-2026-07-27.dump', 'formato de fecha inválido'],
    ['placepos-20260727-135405.sql', 'extensión distinta'],
    ['placepos-20260727-1354.dump', 'hora incompleta'],
    ['', 'vacío'],
  ])('rechaza el nombre %p (%s) sin tocar el bucket', async (name) => {
    const { action, bucketFile } = buildAction();

    await expect(action.remove(name)).rejects.toBeInstanceOf(BadRequestException);
    expect(bucketFile).not.toHaveBeenCalled();
  });
});

describe('ManageBackupAction · descargar', () => {
  it('devuelve una URL firmada de lectura que caduca', async () => {
    const { action, file } = buildAction();

    const before = Date.now();
    const result = await action.downloadUrl(VALID);

    expect(result.url).toBe('https://storage.googleapis.com/firmada');
    expect(result.fileName).toBe(VALID);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(before);

    const options = file.getSignedUrl.mock.calls[0][0];
    expect(options.version).toBe('v4');
    expect(options.action).toBe('read');
    // Enlace efímero: no debe durar horas.
    expect(options.expires - before).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('404 si el respaldo no existe', async () => {
    const { action } = buildAction({ exists: false });

    await expect(action.downloadUrl(VALID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza nombres inválidos también al descargar', async () => {
    const { action, bucketFile } = buildAction();

    await expect(action.downloadUrl('../secreto.json')).rejects.toBeInstanceOf(BadRequestException);
    expect(bucketFile).not.toHaveBeenCalled();
  });
});
