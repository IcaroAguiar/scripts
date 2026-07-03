import { describe, expect, test } from 'bun:test';
import {
  executeConsumoRun,
  preflightConsumoRun,
  type AccessGroupStore,
  type ConsumoEnrollmentsClient,
  type ConsumoExecutionClients,
} from '../src/consumo-execute';
import { buildConsumoPreparedRun, type MappingProfileV2 } from '../src/consumo-plan';
import type { CatalogMap } from '../src/catalog-map';
import { csvRowsToSourceRows } from '../src/migration-plan';
import {
  TetraApiError,
  TetraEnrollmentsClient,
  TetraIamClient,
  TetraProductsClient,
  type TetraFetch,
} from '../src/tetra-api';

const catalogMap: CatalogMap = {
  tenantId: 'tenant_local_tetra',
  generatedAt: '2026-07-01T00:00:00.000Z',
  products: [
    {
      productId: 'prod-excel',
      productTitle: 'Excel Esencial',
      courseId: 'course-excel',
      lessons: [
        { lessonId: 'lesson-1', lessonTitle: 'Clase 1', moduleTitle: 'Intro', order: 1 },
        { lessonId: 'lesson-2', lessonTitle: 'Clase 2', moduleTitle: 'Intro', order: 2 },
      ],
    },
  ],
};

const profile: MappingProfileV2 = {
  version: 2,
  layout: 'themembers-consumo',
  name: 'Perfil execute',
  tenantId: 'tenant_local_tetra',
  environment: 'local',
  accessGroup: {
    mode: 'create',
    name: 'Grupo Anual',
    periodicity: 'YEARLY',
    periodicityValue: 1,
  },
  enrollmentWindow: { accessStartsAt: '2026-01-15', periodicity: 'YEARLY', periodicityValue: 1 },
  catalogMapPath: 'storage/catalog.json',
};

function makePrepared() {
  return buildConsumoPreparedRun(
    csvRowsToSourceRows([
      {
        student_email: 'ada@example.com',
        student_name: 'Ada Lovelace',
        course_title: 'Excel Esencial',
        module_title: 'Intro',
        lesson_title: 'Clase 1',
        finished: '1',
        finished_at: '2026-05-05',
      },
      {
        student_email: 'ada@example.com',
        student_name: 'Ada Lovelace',
        course_title: 'Excel Esencial',
        module_title: 'Intro',
        lesson_title: 'Clase 2',
        finished: '0',
        finished_at: '',
      },
    ]),
    profile,
    catalogMap,
    new Date('2026-07-01T00:00:00Z'),
    'run-exec-1',
  );
}

function makeMemoryStore(): AccessGroupStore & { saved: Record<string, string> } {
  const saved: Record<string, string> = {};
  return {
    saved,
    findCreatedAccessGroup: (tenantId, name) => saved[`${tenantId}:${name}`],
    recordCreatedAccessGroup: (tenantId, name, id) => {
      saved[`${tenantId}:${name}`] = id;
    },
  };
}

function makeEnrollmentsClient(overrides: Partial<ConsumoEnrollmentsClient> = {}) {
  const calls: string[] = [];
  const client: ConsumoEnrollmentsClient = {
    getAccessGroup: async (id) => {
      calls.push(`get-group:${id}`);
      return { id };
    },
    createAccessGroup: async (input) => {
      calls.push(`create-group:${input.name}`);
      return { id: 'ag-created', name: input.name };
    },
    listAccessGroupProducts: async (id) => {
      calls.push(`list-products:${id}`);
      return [];
    },
    addAccessGroupProduct: async (input) => {
      calls.push(`add-product:${input.productId}`);
      return {};
    },
    addAccessGroupMember: async (input) => {
      calls.push(`add-member:${input.userId}`);
      return {};
    },
    findExistingEnrollment: async (input) => {
      calls.push(`find-enrollment:${input.userId}:${input.productId}`);
      return null;
    },
    createManualEnrollment: async (input) => {
      calls.push(
        `create-enrollment:${input.productId}:${input.accessStartsAt}:${input.accessEndsAt}`,
      );
      return {};
    },
    markLessonCompletedInternal: async (input) => {
      calls.push(`progress:${input.lessonId}:${input.occurredAt}`);
      return { alreadyCompleted: false };
    },
    ...overrides,
  };
  return { client, calls };
}

describe('executeConsumoRun', () => {
  const iam = {
    findOrCreateMembers: async (input: {
      tenantId: string;
      members: Array<{ email: string; name?: string }>;
    }) =>
      input.members.map((member) => ({
        email: member.email,
        userId: `user-${member.email.split('@')[0]}`,
        created: true,
      })),
  };

  test('cria grupo, anexa produtos, cria matricula com datas e grava progresso', async () => {
    const prepared = makePrepared();
    const store = makeMemoryStore();
    const { client, calls } = makeEnrollmentsClient();
    const clients: ConsumoExecutionClients = { iam, enrollments: client, accessGroupStore: store };

    const report = await executeConsumoRun(prepared, clients, new Date('2026-07-01T00:00:00Z'));

    expect(report.accessGroup).toEqual({
      id: 'ag-created',
      name: 'Grupo Anual',
      created: true,
      reusedFromLedger: false,
    });
    expect(store.saved['tenant_local_tetra:Grupo Anual']).toBe('ag-created');
    expect(calls).toContain('add-product:prod-excel');
    expect(calls).toContain(
      'create-enrollment:prod-excel:2026-01-15T03:00:00.000Z:2027-01-15T03:00:00.000Z',
    );
    expect(calls).toContain('progress:lesson-1:2026-05-05T03:00:00.000Z');
    expect(report.summary.membersEnsured).toBe(1);
    expect(report.summary.enrollmentsCreated).toBe(1);
    expect(report.summary.progressWritesCreated).toBe(1);

    // Relatorio redigido: sem email/nome.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('ada@example.com');
    expect(serialized).not.toContain('Ada Lovelace');
  });

  test('rerun: grupo do ledger reutilizado, matricula existente e progresso ja concluido viram no-op', async () => {
    const prepared = makePrepared();
    const store = makeMemoryStore();
    store.recordCreatedAccessGroup('tenant_local_tetra', 'Grupo Anual', 'ag-previous');
    const { client, calls } = makeEnrollmentsClient({
      findExistingEnrollment: async () => ({ enrollmentId: 'enr-1' }),
      markLessonCompletedInternal: async () => ({ alreadyCompleted: true }),
      listAccessGroupProducts: async () => [{ productId: 'prod-excel' }],
    });
    const clients: ConsumoExecutionClients = { iam, enrollments: client, accessGroupStore: store };

    const report = await executeConsumoRun(prepared, clients);

    expect(report.accessGroup).toEqual({
      id: 'ag-previous',
      name: 'Grupo Anual',
      created: false,
      reusedFromLedger: true,
    });
    expect(calls.filter((call) => call.startsWith('create-group'))).toHaveLength(0);
    expect(calls.filter((call) => call.startsWith('add-product'))).toHaveLength(0);
    expect(calls.filter((call) => call.startsWith('create-enrollment'))).toHaveLength(0);
    expect(report.summary.enrollmentsExisting).toBe(1);
    expect(report.summary.progressAlreadyCompleted).toBe(1);
    expect(report.summary.progressWritesCreated).toBe(0);
  });

  test('conflito 409 em membership e tratado como sucesso idempotente', async () => {
    const prepared = makePrepared();
    const { client } = makeEnrollmentsClient({
      addAccessGroupMember: async () => {
        throw new TetraApiError('conflict', 'HTTP_ERROR', 409);
      },
    });
    const clients: ConsumoExecutionClients = { iam, enrollments: client };

    const report = await executeConsumoRun(prepared, clients);
    expect(report.summary.membersFailed).toBe(0);
  });

  test('falha em matricula bloqueia os progressos daquele curso', async () => {
    const prepared = makePrepared();
    const { client } = makeEnrollmentsClient({
      createManualEnrollment: async () => {
        throw new TetraApiError('bad request', 'HTTP_ERROR', 400);
      },
    });
    const clients: ConsumoExecutionClients = { iam, enrollments: client };

    const report = await executeConsumoRun(prepared, clients);
    expect(report.summary.enrollmentsFailed).toBe(1);
    expect(report.summary.progressFailed).toBe(1);
    expect(report.results[0]?.progress[0]?.errorCode).toBe('ENROLLMENT_NOT_ENSURED');
    expect(report.results[0]?.status).toBe('failed');
  });
});

describe('preflightConsumoRun', () => {
  test('reporta grupo existente, catalogo alcancavel e produtos anexados', async () => {
    const prepared = buildConsumoPreparedRun(
      csvRowsToSourceRows([
        {
          student_email: 'ada@example.com',
          student_name: 'Ada',
          course_title: 'Excel Esencial',
          module_title: 'Intro',
          lesson_title: 'Clase 1',
          finished: '0',
          finished_at: '',
        },
      ]),
      { ...profile, accessGroup: { mode: 'existing', id: 'ag-1' } },
      catalogMap,
      new Date('2026-07-01T00:00:00Z'),
      'run-preflight',
    );
    const { client } = makeEnrollmentsClient({
      listAccessGroupProducts: async () => [{ productId: 'prod-excel' }],
    });

    const report = await preflightConsumoRun(prepared, {
      iam: { findOrCreateMembers: async () => [] },
      enrollments: client,
      products: { getCourseMap: async () => catalogMap },
    });

    expect(report.summary.failures).toBe(0);
    expect(report.checks.map((check) => `${check.check}:${check.status}`)).toEqual([
      'access_group:ok',
      'planned_products_in_group:ok',
      'catalog_route:ok',
      'planned_products_in_catalog:ok',
    ]);
  });
});

describe('tetra-api contratos consumo', () => {
  function makeFetchRecorder(response: unknown, status = 200) {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: TetraFetch = async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(response), { status });
    };
    return { requests, fetchImpl };
  }

  const tokenProvider = { getToken: async () => 'service-token-123' };

  test('find-or-create-batch envia notifyCreatedUsers false (migracao silenciosa)', async () => {
    const { requests, fetchImpl } = makeFetchRecorder({ users: [] });
    const client = new TetraIamClient({
      iamBaseUrl: 'http://iam.local',
      tokenProvider,
      fetch: fetchImpl,
    });

    await client.findOrCreateMembers({
      tenantId: 'tenant-1',
      members: [{ email: 'ada@example.com' }],
    });

    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.notifyCreatedUsers).toBe(false);
  });

  test('enrollments client envia bearer e chama rota interna de progresso', async () => {
    const { requests, fetchImpl } = makeFetchRecorder({ data: { alreadyCompleted: true } });
    const client = new TetraEnrollmentsClient({
      enrollmentsBaseUrl: 'http://enrollments.local',
      tenantId: 'tenant-1',
      tokenProvider,
      fetch: fetchImpl,
    });

    const result = await client.markLessonCompletedInternal({
      lessonId: 'lesson-1',
      userId: 'user-1',
      courseId: 'course-1',
      occurredAt: '2026-05-05T03:00:00.000Z',
    });

    expect(result.alreadyCompleted).toBe(true);
    const request = requests[0];
    expect(request?.url).toBe(
      'http://enrollments.local/internal/progress/lessons/lesson-1/completed',
    );
    const headers = request?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer service-token-123');
    expect(headers['x-tenant-id']).toBe('tenant-1');
    const body = JSON.parse(String(request?.init?.body));
    expect(body).toEqual({
      userId: 'user-1',
      courseId: 'course-1',
      occurredAt: '2026-05-05T03:00:00.000Z',
    });
  });

  test('enrollments manual envia janelas de acesso', async () => {
    const { requests, fetchImpl } = makeFetchRecorder({});
    const client = new TetraEnrollmentsClient({
      enrollmentsBaseUrl: 'http://enrollments.local',
      tenantId: 'tenant-1',
      tokenProvider,
      fetch: fetchImpl,
    });

    await client.createManualEnrollment({
      userId: 'user-1',
      userName: 'Ada',
      userEmail: 'ada@example.com',
      productId: 'prod-1',
      accessStartsAt: '2026-01-15T03:00:00.000Z',
      accessEndsAt: '2027-01-15T03:00:00.000Z',
    });

    expect(requests[0]?.url).toBe('http://enrollments.local/internal/enrollments/manual');
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer service-token-123');
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.accessStartsAt).toBe('2026-01-15T03:00:00.000Z');
    expect(body.accessEndsAt).toBe('2027-01-15T03:00:00.000Z');
  });

  test('products client consulta course-map interno com bearer e tenant', async () => {
    const { requests, fetchImpl } = makeFetchRecorder(catalogMap);
    const client = new TetraProductsClient({
      productsBaseUrl: 'http://products.local',
      tenantId: 'tenant-1',
      tokenProvider,
      fetch: fetchImpl,
    });

    const map = await client.getCourseMap();
    expect(map.products).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://products.local/internal/catalog/course-map');
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer service-token-123');
    expect(headers['x-tenant-id']).toBe('tenant-1');
  });
});
