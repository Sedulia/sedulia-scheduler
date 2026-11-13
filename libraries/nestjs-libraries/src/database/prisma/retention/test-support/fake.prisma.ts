// A small in-memory stand-in for the Prisma client, for the retention tests only. It is not a mock that
// returns canned answers: it keeps rows, evaluates the where clauses the retention code uses, and enforces
// the foreign keys the real schema has, so a delete in the wrong order fails here the way it would in Postgres.
// It never runs `prisma generate` or touches a database.

type Row = Record<string, any>;

// child table, column, parent table (the schema's required relations that the purge can hit)
const FOREIGN_KEYS: [string, string, string][] = [
  ['integration', 'organizationId', 'organization'],
  ['post', 'organizationId', 'organization'],
  ['post', 'integrationId', 'integration'],
  ['post', 'parentPostId', 'post'],
  ['comments', 'organizationId', 'organization'],
  ['comments', 'postId', 'post'],
  ['comments', 'parentId', 'comments'],
  ['errors', 'organizationId', 'organization'],
  ['errors', 'postId', 'post'],
  ['media', 'organizationId', 'organization'],
  ['tagsPosts', 'postId', 'post'],
  ['payoutProblems', 'postId', 'post'],
  ['plugs', 'integrationId', 'integration'],
  ['exisingPlugData', 'integrationId', 'integration'],
  ['integrationsWebhooks', 'integrationId', 'integration'],
  ['user', 'pictureId', 'media'],
  ['userOrganization', 'organizationId', 'organization'],
  ['userOrganization', 'userId', 'user'],
  ['tags', 'orgId', 'organization'],
  ['tagsPosts', 'tagId', 'tags'],
  ['customer', 'orgId', 'organization'],
  ['integration', 'customerId', 'customer'],
  ['webhooks', 'organizationId', 'organization'],
  ['integrationsWebhooks', 'webhookId', 'webhooks'],
  ['signatures', 'organizationId', 'organization'],
  ['sets', 'organizationId', 'organization'],
  ['autoPost', 'organizationId', 'organization'],
  ['notifications', 'organizationId', 'organization'],
  ['thirdParty', 'organizationId', 'organization'],
  ['gitHub', 'organizationId', 'organization'],
  ['clipping', 'organizationId', 'organization'],
  ['clippingClip', 'clippingId', 'clipping'],
  ['oAuthApp', 'organizationId', 'organization'],
  ['oAuthApp', 'pictureId', 'media'],
  ['oAuthAuthorization', 'organizationId', 'organization'],
  ['oAuthAuthorization', 'oauthAppId', 'oAuthApp'],
];

// where-clause keys that name a relation: table and the column that points at it
const RELATIONS: Record<string, Record<string, [string, string]>> = {
  integration: { organization: ['organization', 'organizationId'] },
};

export const TABLES = [
  'organization',
  'integration',
  'post',
  'comments',
  'errors',
  'media',
  'tagsPosts',
  'payoutProblems',
  'plugs',
  'exisingPlugData',
  'integrationsWebhooks',
  'user',
  'userOrganization',
  'tags',
  'customer',
  'webhooks',
  'signatures',
  'sets',
  'autoPost',
  'notifications',
  'thirdParty',
  'gitHub',
  'clipping',
  'clippingClip',
  'oAuthApp',
  'oAuthAuthorization',
] as const;

export type TableName = (typeof TABLES)[number];

const ops = ['lt', 'lte', 'gt', 'gte', 'in', 'not', 'equals'];

export class FakePrisma {
  data: Record<string, Row[]> = {};
  // every write, in order, so a test can see what was asked and in which order
  writes: { table: string; op: string; where?: any; data?: any }[] = [];
  // the options of every interactive transaction (Prisma's default timeout is 5 seconds)
  transactionOptions: any[] = [];
  [key: string]: any;

  constructor(seed: Partial<Record<TableName, Row[]>> = {}) {
    for (const table of TABLES) {
      this.data[table] = (seed[table] || []).map((row) => ({ ...row }));
      this[table] = this.model(table);
    }
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }

  async $transaction<T>(
    callback: (tx: FakePrisma) => Promise<T>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<T> {
    this.transactionOptions.push(options);
    const before = this.snapshot();
    const writesBefore = this.writes.length;
    try {
      return await callback(this);
    } catch (err) {
      // a real transaction rolls back
      for (const table of TABLES) {
        this.data[table] = before[table].map((row: Row) => reviveDates(row));
      }
      this.writes.length = writesBefore;
      throw err;
    }
  }

  private match(table: string, row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'AND') {
        return [].concat(cond as any).every((c) => this.match(table, row, c));
      }
      if (key === 'OR') {
        return (cond as Row[]).some((c) => this.match(table, row, c));
      }
      if (key === 'NOT') {
        return ![].concat(cond as any).some((c) => this.match(table, row, c));
      }
      const relation = RELATIONS[table]?.[key];
      if (relation) {
        const parent = this.data[relation[0]].find(
          (p) => p.id === row[relation[1]]
        );
        return !!parent && this.match(relation[0], parent, cond as Row);
      }
      return matchValue(row[key], cond);
    });
  }

  private model(table: string) {
    const rows = () => this.data[table];
    const project = (row: Row, select?: Row) => {
      if (!select) {
        return { ...row };
      }
      return Object.fromEntries(
        Object.keys(select)
          .filter((k) => select[k])
          .map((k) => [k, row[k]])
      );
    };
    return {
      findMany: async ({ where, select }: any = {}) =>
        rows()
          .filter((r) => this.match(table, r, where))
          .map((r) => project(r, select)),
      findFirst: async ({ where, select }: any = {}) => {
        const found = rows().find((r) => this.match(table, r, where));
        return found ? project(found, select) : null;
      },
      count: async ({ where }: any = {}) =>
        rows().filter((r) => this.match(table, r, where)).length,
      update: async ({ where, data }: any) => {
        const found = rows().find((r) => this.match(table, r, where));
        if (!found) {
          throw new Error(`P2025 ${table}: record to update not found`);
        }
        this.writes.push({ table, op: 'update', where, data });
        Object.assign(found, data);
        return { ...found };
      },
      // only the unique key the repository uses, organizationId plus internalId
      upsert: async ({ where, create, update }: any) => {
        const key = where.organizationId_internalId;
        const found = rows().find(
          (r) => r.organizationId === key.organizationId && r.internalId === key.internalId
        );
        this.writes.push({ table, op: 'upsert', where });
        if (found) {
          Object.assign(found, update);
          return { ...found };
        }
        const made = { id: `new-${rows().length + 1}`, ...create };
        rows().push(made);
        return { ...made };
      },
      updateMany: async ({ where, data }: any) => {
        const found = rows().filter((r) => this.match(table, r, where));
        this.writes.push({ table, op: 'updateMany', where, data });
        found.forEach((r) => Object.assign(r, data));
        return { count: found.length };
      },
      deleteMany: async ({ where }: any = {}) => {
        const doomed = rows().filter((r) => this.match(table, r, where));
        this.writes.push({ table, op: 'deleteMany', where });
        // a row the statement does not delete may not point at one it does; rows inside the same
        // statement may point at each other (replies, child posts)
        const ids = new Set<string>(doomed.map((r) => r.id).filter(Boolean));
        const blocked = FOREIGN_KEYS.filter(([, , parent]) => parent === table).some(
          ([child, column]) =>
            this.data[child].some(
              (row) =>
                row[column] != null &&
                ids.has(row[column]) &&
                !(child === table && ids.has(row.id))
            )
        );
        if (blocked) {
          throw new Error(`P2003 foreign key violation deleting ${table}`);
        }
        this.data[table] = rows().filter((r) => !doomed.includes(r));
        return { count: doomed.length };
      },
    };
  }
}

function reviveDates(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] =
      typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)
        ? new Date(v)
        : v;
  }
  return out;
}

function matchValue(value: any, cond: any): boolean {
  const isOperator =
    cond !== null &&
    typeof cond === 'object' &&
    !(cond instanceof Date) &&
    Object.keys(cond).every((k) => ops.includes(k));
  if (!isOperator) {
    if (cond === null) {
      return value === null || value === undefined;
    }
    return value === cond;
  }
  return Object.entries(cond).every(([op, expected]: [string, any]) => {
    // SQL: a comparison with NULL is never true, except `not: null`
    if (op === 'not') {
      if (expected === null) {
        return value !== null && value !== undefined;
      }
      return value !== null && value !== undefined && value !== expected;
    }
    if (op === 'equals') {
      return value === expected;
    }
    if (value === null || value === undefined) {
      return false;
    }
    if (op === 'in') {
      return expected.includes(value);
    }
    const a = value instanceof Date ? value.getTime() : value;
    const b = expected instanceof Date ? expected.getTime() : expected;
    return op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b;
  });
}
