import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  THEMEMBERS_BASE_URL: z.string().url(),
  THEMEMBERS_EMAIL: z.string().min(1).optional(),
  THEMEMBERS_PASSWORD: z.string().min(1).optional(),
  THEMEMBERS_COURSE_URL: z.string().url().optional().or(z.literal('')),
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(3),
  DRIVE_SYNC_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  DRIVE_ROOT_FOLDER_NAME: z.string().min(1).default('EAD Migration Bot'),
  DRIVE_EXPORT_DIR: z.string().min(1).default('storage/drive-export')
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(): AppEnv {
  return envSchema.parse(process.env);
}
