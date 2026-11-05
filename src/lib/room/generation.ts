import { z } from 'zod';
import { backendGeneration } from '../firebase/config';
export const ownGenerationSchema = z.literal(backendGeneration);
export const localFormatVersion = 2;
