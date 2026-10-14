import { isFirebaseConfigured } from './config';
import { shapeShyftConfigured } from './env-helper';

export function healthData() {
  return {
    service: 'characterbuilder_api',
    ok: true,
    firebase: isFirebaseConfigured(),
    imageGeneration: shapeShyftConfigured(),
    time: new Date().toISOString(),
  };
}
