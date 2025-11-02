import { PrismaClient } from "@prisma/client";

// Helper function to lowercase Ethereum addresses
function lowercaseAddress(value: any): any {
  if (typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value)) {
    return value.toLowerCase();
  }
  return value;
}

// Helper function to lowercase address fields in data objects
function lowercaseAddressFields(data: any, fields: string[]): any {
  if (!data) return data;

  const result = { ...data };
  for (const field of fields) {
    if (result[field]) {
      result[field] = lowercaseAddress(result[field]);
    }
  }
  return result;
}

const prismaClient = new PrismaClient().$extends({
  query: {
    purchase: {
      async create({ args, query }) {
        args.data = lowercaseAddressFields(args.data, ["payer", "recipient", "tokenLower", "operator"]);
        return query(args);
      },
      async update({ args, query }) {
        args.data = lowercaseAddressFields(args.data, ["payer", "recipient", "tokenLower", "operator"]);
        return query(args);
      },
      async upsert({ args, query }) {
        args.create = lowercaseAddressFields(args.create, ["payer", "recipient", "tokenLower", "operator"]);
        args.update = lowercaseAddressFields(args.update, ["payer", "recipient", "tokenLower", "operator"]);
        return query(args);
      },
      async createMany({ args, query }) {
        if (args.data && Array.isArray(args.data)) {
          args.data = args.data.map(item =>
            lowercaseAddressFields(item, ["payer", "recipient", "tokenLower", "operator"])
          );
        }
        return query(args);
      },
      async updateMany({ args, query }) {
        args.data = lowercaseAddressFields(args.data, ["payer", "recipient", "tokenLower", "operator"]);
        return query(args);
      },
    },
    launch: {
      async create({ args, query }) {
        args.data = lowercaseAddressFields(args.data, ["creator", "tokenLower"]);
        return query(args);
      },
      async update({ args, query }) {
        args.data = lowercaseAddressFields(args.data, ["creator", "tokenLower"]);
        return query(args);
      },
      async upsert({ args, query }) {
        args.create = lowercaseAddressFields(args.create, ["creator", "tokenLower"]);
        args.update = lowercaseAddressFields(args.update, ["creator", "tokenLower"]);
        return query(args);
      },
      async createMany({ args, query }) {
        if (args.data && Array.isArray(args.data)) {
          args.data = args.data.map(item =>
            lowercaseAddressFields(item, ["creator", "tokenLower"])
          );
        }
        return query(args);
      },
      async updateMany({ args, query }) {
        args.data = lowercaseAddressFields(args.data, ["creator", "tokenLower"]);
        return query(args);
      },
    },
  },
});

export const prisma = prismaClient;
