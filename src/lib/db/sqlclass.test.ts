import { describe, expect, it } from "vitest";
import { auditLine, classify, writes } from "./sqlclass";

const pg = (s: string) => classify(s, "postgres");
const my = (s: string) => classify(s, "mysql");

describe("classify", () => {
  it("tells reads from writes, schema changes and the rest", () => {
    expect(pg("select * from t").cls).toBe("read");
    expect(pg("SHOW work_mem").cls).toBe("read");
    expect(pg("insert into t values (1)").cls).toBe("write");
    expect(pg("create index on t (a)").cls).toBe("ddl");
    expect(pg("vacuum analyze t").cls).toBe("admin");
    expect(pg("begin").cls).toBe("tx");
    expect(pg("set search_path = app").cls).toBe("session");
    expect(pg("frobnicate the database").cls).toBe("other");
    expect(my("use billing").cls).toBe("session");
    expect(my("replace into t values (1)").cls).toBe("write");
  });

  it("says a hidden write writes: a CTE, SELECT INTO, EXPLAIN ANALYZE of a DML", () => {
    expect(pg("with gone as (delete from t returning *) select count(*) from gone").cls).toBe("write");
    expect(pg("with x as (select 1) update t set a = 1 from x").verb).toBe("UPDATE");
    expect(pg("select * into backup from t").cls).toBe("write");
    expect(pg("explain analyze delete from t").cls).toBe("write");
    expect(pg("explain delete from t").cls).toBe("read");
  });

  it("calls a SET that would lift read-only a write", () => {
    expect(pg("SET default_transaction_read_only = off").cls).toBe("write");
    expect(pg("set session characteristics as transaction read write").cls).toBe("write");
    expect(my("SET SESSION TRANSACTION READ WRITE").cls).toBe("write");
    expect(pg("set role admin").cls).toBe("write");
    expect(pg("set statement_timeout = '5s'").cls).toBe("session");
    expect(writes(pg("set role admin"))).toBe(true);
    expect(writes(pg("select 1"))).toBe(false);
    expect(writes(pg("frobnicate"))).toBe(true);
  });

  it("asks before what is easy to regret, on any server", () => {
    expect(pg("delete from sessions").confirm).toBe("noWhere");
    expect(pg("update t set a = 1").confirm).toBe("noWhere");
    expect(pg("delete from t where id = 1").confirm).toBeNull();
    expect(pg("update t set a = (select 1 where true)").confirm).toBe("noWhere");
    expect(pg("drop table t").confirm).toBe("drop");
    expect(pg("truncate t").confirm).toBe("drop");
    expect(pg("alter table t drop column a").confirm).toBe("alter");
    expect(my("grant select on db.* to x").confirm).toBe("grants");
    expect(pg("select 1").confirm).toBeNull();
  });

  it("names the verb and the tables, never the values", () => {
    const c = pg("UPDATE public.invoices SET note = 'secret 42' WHERE id = 7");
    expect(c.verb).toBe("UPDATE");
    expect(c.tables).toEqual(["public.invoices"]);
    expect(auditLine(c)).toBe("UPDATE public.invoices");
    expect(auditLine(pg("delete from only t where x in (select y from u)"))).toBe("DELETE t, u");
    expect(auditLine(pg("create unique index i on t (a)"))).toBe("CREATE UNIQUE INDEX");
    expect(auditLine(pg("drop table if exists t"))).toBe("DROP TABLE t");
    expect(auditLine(my("insert into `orders` (a) values ('x')"))).toBe("INSERT `orders`");
  });

  it("says which statements EXPLAIN shows, and which it may run", () => {
    expect(pg("select 1").analyzable).toBe(true);
    expect(pg("update t set a = 1 where id = 1").explainable).toBe(true);
    expect(pg("update t set a = 1 where id = 1").analyzable).toBe(false);
    expect(pg("create table t (a int)").explainable).toBe(false);
    expect(pg("explain select 1").explainable).toBe(false);
  });
});
