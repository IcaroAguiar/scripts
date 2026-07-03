import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProfileV2,
  deriveProfileFileName,
  validateGroupId,
  validateGroupName,
  validatePeriodicityValue,
  validateStartDate,
  validateTenantId,
  writeProfileFile,
} from "../src/profile-builder";

describe("validadores de perfil (mensagens para operador nao-dev)", () => {
  test("tenant obrigatorio e sem espacos", () => {
    expect(validateTenantId("")).toContain("Informe");
    expect(validateTenantId("tenant com espaco")).toContain("espacos");
    expect(validateTenantId("tenant_local_tetra")).toBeUndefined();
  });

  test("nome/id de grupo", () => {
    expect(validateGroupName("")).toContain("Informe");
    expect(validateGroupName("Migracao Periodo 2")).toBeUndefined();
    expect(validateGroupId("")).toContain("Informe");
    expect(validateGroupId("ag-123")).toBeUndefined();
  });

  test("data de inicio exige YYYY-MM-DD valido", () => {
    expect(validateStartDate("15/01/2026")).toContain("YYYY-MM-DD");
    expect(validateStartDate("2026-13-99")).toBeDefined();
    expect(validateStartDate("2026-01-15")).toBeUndefined();
  });

  test("multiplicador inteiro positivo", () => {
    expect(validatePeriodicityValue("0")).toBeDefined();
    expect(validatePeriodicityValue("abc")).toBeDefined();
    expect(validatePeriodicityValue("6")).toBeUndefined();
  });
});

describe("buildProfileV2", () => {
  test("monta perfil com grupo novo e janela", () => {
    const profile = buildProfileV2({
      name: "TheMembers Periodo 2",
      tenantId: "tenant_local_tetra",
      environment: "dev",
      groupMode: "create",
      groupName: "Migracao Periodo 2",
      accessStartsAt: "2026-01-15",
      periodicity: "YEARLY",
      periodicityValue: 1,
    });

    expect(profile.version).toBe(2);
    expect(profile.layout).toBe("themembers-consumo");
    expect(profile.accessGroup).toEqual({
      mode: "create",
      name: "Migracao Periodo 2",
      periodicity: "YEARLY",
      periodicityValue: 1,
    });
    expect(profile.enrollmentWindow.accessStartsAt).toBe("2026-01-15");
    expect(profile.catalogMapPath).toBe("./catalog-map.tenant-local-tetra.json");
  });

  test("grupo existente usa o id informado", () => {
    const profile = buildProfileV2({
      name: "Demo",
      tenantId: "tenant_local_tetra",
      environment: "local",
      groupMode: "existing",
      groupId: "ag-999",
      accessStartsAt: "2026-06-01",
      periodicity: "MONTHLY",
      periodicityValue: 6,
    });

    expect(profile.accessGroup).toEqual({ mode: "existing", id: "ag-999" });
  });
});

describe("writeProfileFile", () => {
  test("grava JSON e nunca sobrescreve arquivo existente", async () => {
    const dir = await mkdtemp(join(tmpdir(), "profile-builder-"));
    try {
      const profile = buildProfileV2({
        name: "Periodo 2",
        tenantId: "tenant_local_tetra",
        environment: "local",
        groupMode: "create",
        groupName: "G",
        accessStartsAt: "2026-01-15",
        periodicity: "YEARLY",
        periodicityValue: 1,
      });

      const first = await writeProfileFile(dir, "Periodo 2", profile);
      const second = await writeProfileFile(dir, "Periodo 2", profile);

      expect(first).toBe(join(dir, "profile.periodo-2.json"));
      expect(second).toBe(join(dir, "profile.periodo-2-2.json"));

      const parsed = JSON.parse(await readFile(first, "utf8"));
      expect(parsed.tenantId).toBe("tenant_local_tetra");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deriveProfileFileName normaliza acentos e espacos", () => {
    expect(deriveProfileFileName("Migração Período 2")).toBe("profile.migracao-periodo-2.json");
    expect(deriveProfileFileName("")).toBe("profile.migracao.json");
  });
});
