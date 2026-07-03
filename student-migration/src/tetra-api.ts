import type { ProductType } from "./migration-plan";

export type TetraFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type ServiceTokenProvider = {
  getToken(): Promise<string>;
};

export type TetraServiceTokenProviderOptions = {
  iamBaseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  fetch?: TetraFetch;
};

export class TetraServiceTokenProvider implements ServiceTokenProvider {
  private readonly fetch: TetraFetch;
  private cachedToken: string | null = null;

  constructor(private readonly options: TetraServiceTokenProviderOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async getToken(): Promise<string> {
    if (this.cachedToken) {
      return this.cachedToken;
    }

    const payload = await postJson<{ access_token?: string }>(
      this.fetch,
      `${normalizeBaseUrl(this.options.iamBaseUrl)}/oauth2-secure/service-token`,
      {
        grant_type: "client_credentials",
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        scope: this.options.scope,
      },
    );

    if (!payload.access_token) {
      throw new TetraApiError("IAM service-token response did not include access_token.", "BAD_TOKEN_RESPONSE");
    }

    this.cachedToken = payload.access_token;
    return payload.access_token;
  }
}

export type TetraIamClientOptions = {
  iamBaseUrl: string;
  tokenProvider: ServiceTokenProvider;
  fetch?: TetraFetch;
};

export type FindOrCreateMembersInput = {
  tenantId: string;
  members: Array<{
    email: string;
    name?: string;
  }>;
};

export type FindOrCreateMemberResult = {
  email: string;
  userId: string | null;
  created: boolean;
  error?: string;
};

export class TetraIamClient {
  private readonly fetch: TetraFetch;

  constructor(private readonly options: TetraIamClientOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async findOrCreateMembers(input: FindOrCreateMembersInput): Promise<FindOrCreateMemberResult[]> {
    const token = await this.options.tokenProvider.getToken();
    const results: FindOrCreateMemberResult[] = [];

    for (const members of chunk(input.members, 500)) {
      const payload = await postJson<{ users?: FindOrCreateMemberResult[] }>(
        this.fetch,
        `${normalizeBaseUrl(this.options.iamBaseUrl)}/internal/users/find-or-create-batch`,
        {
          tenantId: input.tenantId,
          users: members,
          // Migracao silenciosa: membros importados nunca recebem email de
          // boas-vindas; a senha padrao e comunicada fora do sistema.
          notifyCreatedUsers: false,
        },
        {
          Authorization: `Bearer ${token}`,
        },
      );
      results.push(...(payload.users ?? []));
    }

    return results;
  }
}

export type TetraEnrollmentsClientOptions = {
  enrollmentsBaseUrl: string;
  tenantId: string;
  /** Quando presente, todas as chamadas enviam Authorization: Bearer. */
  tokenProvider?: ServiceTokenProvider;
  fetch?: TetraFetch;
};

export type AddAccessGroupMemberInput = {
  accessGroupId: string;
  userId: string;
  name: string;
  email: string;
  role?: string;
  addedBy?: string;
};

export type CreateEnrollmentClientInput = {
  userId: string;
  userName?: string;
  userEmail?: string;
  productId: string;
  productName?: string;
  courseId?: string;
  productType: ProductType;
  productOwnerTenantId?: string;
  accessGroupId?: string;
};

export type FindExistingEnrollmentInput = {
  userId: string;
  productId: string;
  accessGroupId?: string;
};

export class TetraEnrollmentsClient {
  private readonly fetch: TetraFetch;

  constructor(private readonly options: TetraEnrollmentsClientOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async getAccessGroup(accessGroupId: string): Promise<unknown | null> {
    return getOptionalJson(
      this.fetch,
      `${normalizeBaseUrl(this.options.enrollmentsBaseUrl)}/access-groups/${encodeURIComponent(accessGroupId)}`,
      await this.authenticatedTenantHeaders(),
    );
  }

  async listAccessGroupProducts(accessGroupId: string): Promise<unknown[]> {
    const payload = await getJson<unknown>(
      this.fetch,
      `${normalizeBaseUrl(this.options.enrollmentsBaseUrl)}/access-groups/${encodeURIComponent(accessGroupId)}/products`,
      await this.authenticatedTenantHeaders(),
    );
    return listItems(payload);
  }

  async addAccessGroupMember(input: AddAccessGroupMemberInput): Promise<unknown> {
    const { accessGroupId, ...body } = input;
    return postJson(
      this.fetch,
      `${normalizeBaseUrl(this.options.enrollmentsBaseUrl)}/access-groups/${encodeURIComponent(accessGroupId)}/members`,
      body,
      await this.authenticatedTenantHeaders(),
    );
  }

  async createEnrollment(input: CreateEnrollmentClientInput): Promise<unknown> {
    return postJson(
      this.fetch,
      `${normalizeBaseUrl(this.options.enrollmentsBaseUrl)}/enrollments`,
      input,
      await this.authenticatedTenantHeaders(),
    );
  }

  async findExistingEnrollment(input: FindExistingEnrollmentInput): Promise<unknown | null> {
    const params = new URLSearchParams({
      userId: input.userId,
      productId: input.productId,
    });
    if (input.accessGroupId) {
      params.set("accessGroupId", input.accessGroupId);
    }
    params.set("pageSize", "1");

    const payload = await getJson<unknown>(
      this.fetch,
      `${normalizeBaseUrl(this.options.enrollmentsBaseUrl)}/enrollments?${params.toString()}`,
      await this.authenticatedTenantHeaders(),
    );

    return firstListItem(payload);
  }

  async createAccessGroup(input: CreateAccessGroupInput): Promise<CreatedAccessGroup> {
    const payload = await postJson<Record<string, unknown>>(
      this.fetch,
      `${normalizeBaseUrl(this.options.enrollmentsBaseUrl)}/internal/access-groups`,
      input,
      await this.internalServiceHeaders(),
    );

    const record = unwrapRecord(payload);
    const id =
      readString(record, "id") ??
      readString(record, "accessGroupId") ??
      readString(record, "access_group_id");
    if (!id) {
      throw new TetraApiError(
        "Create access group response did not include an id.",
        "BAD_ACCESS_GROUP_RESPONSE",
      );
    }

    return { id, name: readString(record, "name") ?? input.name };
  }

  async addAccessGroupProduct(input: AddAccessGroupProductInput): Promise<unknown> {
    const { accessGroupId, ...body } = input;
    return postJson(
      this.fetch,
      `${normalizeBaseUrl(this.options.enrollmentsBaseUrl)}/access-groups/${encodeURIComponent(accessGroupId)}/products`,
      body,
      await this.authenticatedTenantHeaders(),
    );
  }

  async createManualEnrollment(input: CreateManualEnrollmentClientInput): Promise<unknown> {
    return postJson(
      this.fetch,
      `${normalizeBaseUrl(this.options.enrollmentsBaseUrl)}/internal/enrollments/manual`,
      input,
      await this.internalServiceHeaders(),
    );
  }

  async markLessonCompletedInternal(
    input: MarkLessonCompletedInternalInput,
  ): Promise<MarkLessonCompletedInternalResult> {
    const { lessonId, ...body } = input;
    const payload = await postJson<Record<string, unknown>>(
      this.fetch,
      `${normalizeBaseUrl(this.options.enrollmentsBaseUrl)}/internal/progress/lessons/${encodeURIComponent(lessonId)}/completed`,
      body,
      await this.internalServiceHeaders(),
    );

    const record = unwrapRecord(payload);
    return { alreadyCompleted: record.alreadyCompleted === true };
  }

  // Rotas publicas do enrollments validam bearer como token de USUARIO; o
  // token de servico so e aceito nas rotas /internal. Fora delas, o caminho
  // suportado hoje e a compatibilidade via x-tenant-id sem Authorization.
  private async authenticatedTenantHeaders(): Promise<Record<string, string>> {
    return {
      "x-tenant-id": this.options.tenantId,
    };
  }

  private async internalServiceHeaders(): Promise<Record<string, string>> {
    if (!this.options.tokenProvider) {
      throw new TetraApiError(
        "Internal enrollments routes require a service token provider.",
        "MISSING_TOKEN_PROVIDER",
      );
    }

    return {
      "x-tenant-id": this.options.tenantId,
      Authorization: `Bearer ${await this.options.tokenProvider.getToken()}`,
    };
  }
}

export type CreateAccessGroupInput = {
  name: string;
  description?: string;
  periodicity?: "DAILY" | "MONTHLY" | "YEARLY";
  periodicityValue?: number;
};

export type CreatedAccessGroup = {
  id: string;
  name: string;
};

export type AddAccessGroupProductInput = {
  accessGroupId: string;
  productId: string;
  productType: ProductType;
  productOwnerTenantId?: string;
  periodicity?: "DAILY" | "MONTHLY" | "YEARLY";
  periodicityValue?: number;
};

export type CreateManualEnrollmentClientInput = {
  userId: string;
  userName?: string;
  userEmail?: string;
  productId: string;
  accessStartsAt: string;
  accessEndsAt: string;
};

export type MarkLessonCompletedInternalInput = {
  lessonId: string;
  userId: string;
  courseId: string;
  occurredAt: string;
  productId?: string;
};

export type MarkLessonCompletedInternalResult = {
  alreadyCompleted: boolean;
};

export type TetraProductsClientOptions = {
  productsBaseUrl: string;
  tenantId: string;
  tokenProvider: ServiceTokenProvider;
  fetch?: TetraFetch;
};

export type CourseMapResponse = {
  tenantId: string;
  generatedAt: string;
  products: Array<{
    productId: string;
    productTitle: string;
    courseId: string;
    lessons: Array<{
      lessonId: string;
      lessonTitle: string;
      moduleTitle: string | null;
      order: number;
    }>;
  }>;
};

export class TetraProductsClient {
  private readonly fetch: TetraFetch;

  constructor(private readonly options: TetraProductsClientOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async getCourseMap(): Promise<CourseMapResponse> {
    const token = await this.options.tokenProvider.getToken();
    const payload = await getJson<Record<string, unknown>>(
      this.fetch,
      `${normalizeBaseUrl(this.options.productsBaseUrl)}/internal/catalog/course-map`,
      {
        Authorization: `Bearer ${token}`,
        "x-tenant-id": this.options.tenantId,
      },
    );

    const record = unwrapRecord(payload);
    if (!Array.isArray(record.products)) {
      throw new TetraApiError(
        "Course map response did not include a products array.",
        "BAD_COURSE_MAP_RESPONSE",
      );
    }

    return record as CourseMapResponse;
  }
}

export class TetraApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TetraApiError";
  }
}

async function postJson<T>(
  fetchImpl: TetraFetch,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  return requestJson<T>(fetchImpl, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function getJson<T>(
  fetchImpl: TetraFetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<T> {
  return requestJson<T>(fetchImpl, url, {
    method: "GET",
    headers,
  });
}

async function getOptionalJson<T>(
  fetchImpl: TetraFetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<T | null> {
  try {
    return await getJson<T>(fetchImpl, url, headers);
  } catch (error) {
    if (error instanceof TetraApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function requestJson<T>(fetchImpl: TetraFetch, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  const payload = await readJson(response);

  if (!response.ok) {
    throw new TetraApiError(
      `Tetra API request failed with status ${response.status}.`,
      "HTTP_ERROR",
      response.status,
    );
  }

  return payload as T;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function unwrapRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const record = payload as Record<string, unknown>;
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>;
  }

  return record;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function firstListItem(payload: unknown): unknown | null {
  return listItems(payload)[0] ?? null;
}

function listItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as {
    items?: unknown[];
    data?: unknown;
    results?: unknown[];
    products?: unknown[];
    enrollments?: unknown[];
  };
  if (record.items) return record.items;
  if (record.results) return record.results;
  if (record.products) return record.products;
  if (record.enrollments) return record.enrollments;
  if (record.data) return listItems(record.data);
  return [];
}
