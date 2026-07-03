import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccessGroupStore, ConsumoExecuteReport } from "./consumo-execute";
import type { ConsumoRunPlan } from "./consumo-plan";
import type { ExecuteReport } from "./execute";
import type { RunPlan } from "./migration-plan";

export type MigrationLedger = AccessGroupStore & {
  recordDryRun(plan: RunPlan): void;
  recordExecute(report: ExecuteReport): void;
  recordConsumoDryRun(plan: ConsumoRunPlan): void;
  recordConsumoExecute(report: ConsumoExecuteReport): void;
  close(): void;
};

export async function openMigrationLedger(path: string): Promise<MigrationLedger> {
  await mkdir(dirname(path), { recursive: true });

  const database = new Database(path);
  database.exec(`
    create table if not exists runs (
      run_id text primary key,
      tenant_id text not null,
      environment text not null,
      generated_at text not null,
      total_rows integer not null,
      executable_rows integer not null,
      blocked_rows integer not null,
      duplicate_rows integer not null,
      created_at text not null default current_timestamp
    );

    create table if not exists execute_reports (
      run_id text primary key,
      adapter text not null,
      executed_at text not null,
      attempted_operations integer not null,
      succeeded_operations integer not null,
      failed_operations integer not null,
      skipped_blocked_rows integer not null,
      progress_writes integer not null,
      foreign key (run_id) references runs(run_id)
    );

    create table if not exists operation_results (
      run_id text not null,
      operation_id text not null,
      status text not null,
      source_ref_count integer not null,
      member_ref text not null,
      access_group_id text not null,
      product_id text not null,
      progress_write_planned integer not null,
      error_code text,
      primary key (run_id, operation_id),
      foreign key (run_id) references runs(run_id)
    );

    create table if not exists consumo_runs (
      run_id text primary key,
      tenant_id text not null,
      environment text not null,
      generated_at text not null,
      total_rows integer not null,
      member_operations integer not null,
      planned_enrollments integer not null,
      planned_progress_writes integer not null,
      blocked_rows integer not null,
      progress_only_blocked_rows integer not null,
      created_at text not null default current_timestamp
    );

    create table if not exists member_operation_results (
      run_id text not null,
      operation_id text not null,
      status text not null,
      member_ref text not null,
      access_group_id text not null,
      error_code text,
      primary key (run_id, operation_id)
    );

    create table if not exists enrollment_results (
      run_id text not null,
      operation_id text not null,
      product_id text not null,
      status text not null,
      error_code text,
      primary key (run_id, operation_id, product_id)
    );

    create table if not exists progress_results (
      run_id text not null,
      operation_id text not null,
      lesson_id text not null,
      status text not null,
      error_code text,
      primary key (run_id, operation_id, lesson_id)
    );

    create table if not exists created_access_groups (
      tenant_id text not null,
      name text not null,
      access_group_id text not null,
      created_at text not null default current_timestamp,
      primary key (tenant_id, name)
    );
  `);

  const insertRun = database.query(`
    insert into runs (
      run_id,
      tenant_id,
      environment,
      generated_at,
      total_rows,
      executable_rows,
      blocked_rows,
      duplicate_rows
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(run_id) do update set
      tenant_id = excluded.tenant_id,
      environment = excluded.environment,
      generated_at = excluded.generated_at,
      total_rows = excluded.total_rows,
      executable_rows = excluded.executable_rows,
      blocked_rows = excluded.blocked_rows,
      duplicate_rows = excluded.duplicate_rows
  `);

  const insertExecuteReport = database.query(`
    insert into execute_reports (
      run_id,
      adapter,
      executed_at,
      attempted_operations,
      succeeded_operations,
      failed_operations,
      skipped_blocked_rows,
      progress_writes
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(run_id) do update set
      adapter = excluded.adapter,
      executed_at = excluded.executed_at,
      attempted_operations = excluded.attempted_operations,
      succeeded_operations = excluded.succeeded_operations,
      failed_operations = excluded.failed_operations,
      skipped_blocked_rows = excluded.skipped_blocked_rows,
      progress_writes = excluded.progress_writes
  `);

  const insertOperationResult = database.query(`
    insert into operation_results (
      run_id,
      operation_id,
      status,
      source_ref_count,
      member_ref,
      access_group_id,
      product_id,
      progress_write_planned,
      error_code
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(run_id, operation_id) do update set
      status = excluded.status,
      source_ref_count = excluded.source_ref_count,
      member_ref = excluded.member_ref,
      access_group_id = excluded.access_group_id,
      product_id = excluded.product_id,
      progress_write_planned = excluded.progress_write_planned,
      error_code = excluded.error_code
  `);

  const insertConsumoRun = database.query(`
    insert into consumo_runs (
      run_id, tenant_id, environment, generated_at, total_rows,
      member_operations, planned_enrollments, planned_progress_writes,
      blocked_rows, progress_only_blocked_rows
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(run_id) do update set
      tenant_id = excluded.tenant_id,
      environment = excluded.environment,
      generated_at = excluded.generated_at,
      total_rows = excluded.total_rows,
      member_operations = excluded.member_operations,
      planned_enrollments = excluded.planned_enrollments,
      planned_progress_writes = excluded.planned_progress_writes,
      blocked_rows = excluded.blocked_rows,
      progress_only_blocked_rows = excluded.progress_only_blocked_rows
  `);

  const insertMemberOperationResult = database.query(`
    insert into member_operation_results (
      run_id, operation_id, status, member_ref, access_group_id, error_code
    ) values (?, ?, ?, ?, ?, ?)
    on conflict(run_id, operation_id) do update set
      status = excluded.status,
      member_ref = excluded.member_ref,
      access_group_id = excluded.access_group_id,
      error_code = excluded.error_code
  `);

  const insertEnrollmentResult = database.query(`
    insert into enrollment_results (
      run_id, operation_id, product_id, status, error_code
    ) values (?, ?, ?, ?, ?)
    on conflict(run_id, operation_id, product_id) do update set
      status = excluded.status,
      error_code = excluded.error_code
  `);

  const insertProgressResult = database.query(`
    insert into progress_results (
      run_id, operation_id, lesson_id, status, error_code
    ) values (?, ?, ?, ?, ?)
    on conflict(run_id, operation_id, lesson_id) do update set
      status = excluded.status,
      error_code = excluded.error_code
  `);

  const findCreatedAccessGroupQuery = database.query(`
    select access_group_id from created_access_groups where tenant_id = ? and name = ?
  `);

  const insertCreatedAccessGroup = database.query(`
    insert into created_access_groups (tenant_id, name, access_group_id)
    values (?, ?, ?)
    on conflict(tenant_id, name) do update set access_group_id = excluded.access_group_id
  `);

  return {
    recordDryRun(plan: RunPlan): void {
      insertRun.run(
        plan.runId,
        plan.tenantId,
        plan.environment,
        plan.generatedAt,
        plan.source.totalRows,
        plan.source.executableRows,
        plan.source.blockedRows,
        plan.source.duplicateRows,
      );
    },
    recordExecute(report: ExecuteReport): void {
      insertExecuteReport.run(
        report.runId,
        report.adapter,
        report.executedAt,
        report.summary.attemptedOperations,
        report.summary.succeededOperations,
        report.summary.failedOperations,
        report.summary.skippedBlockedRows,
        report.summary.progressWrites,
      );

      for (const result of report.results) {
        insertOperationResult.run(
          report.runId,
          result.operationId,
          result.status,
          result.sourceRefCount,
          result.memberRef,
          result.accessGroupId,
          result.productId,
          result.progressWritePlanned ? 1 : 0,
          result.errorCode ?? null,
        );
      }
    },
    recordConsumoDryRun(plan: ConsumoRunPlan): void {
      insertConsumoRun.run(
        plan.runId,
        plan.tenantId,
        plan.environment,
        plan.generatedAt,
        plan.source.totalRows,
        plan.source.memberOperations,
        plan.source.plannedEnrollments,
        plan.source.plannedProgressWrites,
        plan.source.blockedRows,
        plan.source.progressOnlyBlockedRows,
      );
    },
    recordConsumoExecute(report: ConsumoExecuteReport): void {
      for (const result of report.results) {
        insertMemberOperationResult.run(
          report.runId,
          result.operationId,
          result.status,
          result.memberRef,
          report.accessGroup.id,
          result.errorCode ?? null,
        );

        for (const enrollment of result.enrollments) {
          insertEnrollmentResult.run(
            report.runId,
            result.operationId,
            enrollment.productId,
            enrollment.status,
            enrollment.errorCode ?? null,
          );
        }

        for (const write of result.progress) {
          insertProgressResult.run(
            report.runId,
            result.operationId,
            write.lessonId,
            write.status,
            write.errorCode ?? null,
          );
        }
      }
    },
    findCreatedAccessGroup(tenantId: string, name: string): string | undefined {
      const row = findCreatedAccessGroupQuery.get(tenantId, name) as
        | { access_group_id?: string }
        | null;
      return row?.access_group_id ?? undefined;
    },
    recordCreatedAccessGroup(tenantId: string, name: string, accessGroupId: string): void {
      insertCreatedAccessGroup.run(tenantId, name, accessGroupId);
    },
    close(): void {
      database.close();
    },
  };
}
