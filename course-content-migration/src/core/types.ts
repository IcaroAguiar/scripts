export type PlatformId = 'themembers' | 'hotmart' | 'kiwify' | string;

export type AssetType = 'document' | 'audio' | 'image' | 'external-link' | 'unknown';

export type AssetStatus = 'pending' | 'downloaded' | 'skipped' | 'failed';
export type UploadStatus = 'pending' | 'uploaded' | 'skipped' | 'failed';

export interface CourseRef {
  id: string;
  name: string;
  url: string;
}

export interface Asset {
  type: AssetType;
  name: string;
  url: string;
  sha256: string | null;
  localPath?: string;
  targetPath?: string;
  status?: AssetStatus;
  uploadStatus?: UploadStatus;
  driveFileId?: string;
  driveWebUrl?: string;
  lastError?: string;
}

export interface LessonContent {
  description: string;
  links: string[];
  assets: Asset[];
}

export interface LessonManifest extends LessonContent {
  name: string;
  displayName?: string;
  index: number;
  url: string;
  slug: string;
  status?: 'discovered' | 'failed';
  lastError?: string;
}

export interface ModuleManifest {
  name: string;
  index: number;
  slug: string;
  lessons: LessonManifest[];
}

export interface CourseManifest {
  platform: PlatformId;
  course: string;
  courseId: string;
  url: string;
  slug: string;
  discoveredAt: string;
  modules: ModuleManifest[];
}

export interface RuntimeContext {
  platform: PlatformId;
  headless: boolean;
  authStatePath: string;
  manifestDir: string;
  downloadsDir: string;
  logsDir: string;
}

export interface PlatformAdapter {
  platform: PlatformId;
  login(context: RuntimeContext): Promise<void>;
  discoverCourses(context: RuntimeContext): Promise<CourseRef[]>;
  discoverCourse(context: RuntimeContext, course: CourseRef): Promise<CourseManifest>;
  extractLessonContent(context: RuntimeContext, lessonUrl: string, lessonName?: string): Promise<LessonContent>;
}

export interface DriveFolderRef {
  id: string;
  name: string;
  path: string;
  webUrl?: string;
}

export interface DriveFileRef {
  id: string;
  name: string;
  path: string;
  webUrl?: string;
}

export interface DriveCourseTree {
  root: DriveFolderRef;
  platform: DriveFolderRef;
  course: DriveFolderRef;
  manifests: DriveFolderRef;
}

export interface DriveUploadResult {
  assetUrl: string;
  status: UploadStatus;
  file?: DriveFileRef;
  error?: string;
}

export interface DriveStorageAdapter {
  ensureRootFolder(): Promise<DriveFolderRef>;
  ensureCourseTree(manifest: CourseManifest): Promise<DriveCourseTree>;
  uploadLessonFiles(manifest: CourseManifest, lesson: LessonManifest): Promise<DriveUploadResult[]>;
  uploadManifest(manifest: CourseManifest): Promise<DriveFileRef>;
}
