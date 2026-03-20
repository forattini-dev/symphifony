import { S3DB_EVENT_RESOURCE } from "../../concerns/constants.ts";

export default {
  name: S3DB_EVENT_RESOURCE,
  attributes: {
    id: "string|required",
    issueId: "string|optional",
    kind: "string|required",
    message: "string|required",
    at: "datetime|required",
  },
  partitions: {
    byIssueId: { fields: { issueId: "string" } },
    byKind: { fields: { kind: "string" } },
    byIssueIdAndKind: { fields: { issueId: "string", kind: "string" } },
  },
  asyncPartitions: true,
  behavior: "body-overflow",
  paranoid: false,
  timestamps: false,
  api: {
    auth: false,
    methods: ["GET", "HEAD", "OPTIONS"],
    description: "Runtime event log entries",
  },
};
