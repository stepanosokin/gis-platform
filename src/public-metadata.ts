import express from 'express';
import { featuresError, mountFeaturesMetadata, readManagedMetadata } from './features-metadata.js';

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const metadata = await readManagedMetadata();
const modes = Object.fromEntries(Object.values(metadata).flatMap(({ collections }) =>
  collections.map(({ id }) => [id, 'public' as const])));
mountFeaturesMetadata(app, modes, '', async () => null, metadata);
app.use(((_error, _req, res, _next) => featuresError(res, 503)) satisfies express.ErrorRequestHandler);
app.listen(3000, '0.0.0.0');
