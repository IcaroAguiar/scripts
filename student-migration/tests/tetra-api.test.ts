import { describe, expect, test } from "bun:test";
import {
  TetraEnrollmentsClient,
  TetraIamClient,
  TetraServiceTokenProvider,
  type TetraFetch,
} from "../src/tetra-api";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("TetraServiceTokenProvider", () => {
  test("requests the existing IAM client_credentials service-token endpoint without exposing the secret", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch: TetraFetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        access_token: "token_dev",
        token_type: "Bearer",
        expires_in: 3600,
      });
    };

    const provider = new TetraServiceTokenProvider({
      iamBaseUrl: "http://localhost:3335/",
      clientId: "tetra-imports-service",
      clientSecret: "not-a-real-test-placeholder",
      scope: "iam:provision-users",
      fetch,
    });

    await expect(provider.getToken()).resolves.toBe("token_dev");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: "http://localhost:3335/oauth2-secure/service-token",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: "tetra-imports-service",
          client_secret: "not-a-real-test-placeholder",
          scope: "iam:provision-users",
        }),
      },
    });
  });
});

describe("TetraIamClient", () => {
  test("chunks member provisioning requests at the IAM batch limit", async () => {
    const batches: unknown[] = [];
    const fetch: TetraFetch = async (_url, init) => {
      batches.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        users: [{ email: "membro.0@example.test", userId: "user_0", created: false }],
      });
    };
    const tokenProvider = { getToken: async () => "token_dev" };
    const client = new TetraIamClient({
      iamBaseUrl: "http://localhost:3335",
      tokenProvider,
      fetch,
    });
    const members = Array.from({ length: 501 }, (_, index) => ({
      email: `membro.${index}@example.test`,
      name: `Membro ${index}`,
    }));

    await client.findOrCreateMembers({
      tenantId: "tenant_fake_001",
      members,
    });

    expect(batches).toHaveLength(2);
    expect((batches[0] as { users: unknown[] }).users).toHaveLength(500);
    expect((batches[1] as { users: unknown[] }).users).toHaveLength(1);
  });
});

describe("TetraEnrollmentsClient", () => {
  test("uses current x-tenant-id compatible enrollments endpoints without service bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch: TetraFetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ id: "ok" });
    };
    const client = new TetraEnrollmentsClient({
      enrollmentsBaseUrl: "http://localhost:3338/",
      tenantId: "tenant_fake_001",
      fetch,
    });

    await client.addAccessGroupMember({
      accessGroupId: "ag_fake_001",
      userId: "user_001",
      name: "Membro Um",
      email: "membro.um@example.test",
    });
    await client.createEnrollment({
      userId: "user_001",
      userName: "Membro Um",
      userEmail: "membro.um@example.test",
      productId: "prod_fake_001",
      productName: "Curso Fake",
      productType: "COURSE",
      courseId: "course_fake_001",
      accessGroupId: "ag_fake_001",
    });
    await client.findExistingEnrollment({
      userId: "user_001",
      productId: "prod_fake_001",
      accessGroupId: "ag_fake_001",
    });

    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ["http://localhost:3338/access-groups/ag_fake_001/members", "POST"],
      ["http://localhost:3338/enrollments", "POST"],
      [
        "http://localhost:3338/enrollments?userId=user_001&productId=prod_fake_001&accessGroupId=ag_fake_001&pageSize=1",
        "GET",
      ],
    ]);
    expect(calls[0]?.init.headers).toEqual({
      "Content-Type": "application/json",
      "x-tenant-id": "tenant_fake_001",
    });
    expect(calls[1]?.init.headers).toEqual({
      "Content-Type": "application/json",
      "x-tenant-id": "tenant_fake_001",
    });
    expect(calls[2]?.init.headers).toEqual({
      "x-tenant-id": "tenant_fake_001",
    });
  });

  test("unwraps access-group products from the current response envelope", async () => {
    const client = new TetraEnrollmentsClient({
      enrollmentsBaseUrl: "http://localhost:3338/",
      tenantId: "tenant_fake_001",
      fetch: async () =>
        jsonResponse({
          data: {
            products: [{ productId: "prod_fake_001" }],
          },
        }),
    });

    await expect(client.listAccessGroupProducts("ag_fake_001")).resolves.toEqual([
      { productId: "prod_fake_001" },
    ]);
  });
});
