import { S3DB_AGENT_SESSION_RESOURCE } from "../../concerns/constants.ts";

export default {
  name: S3DB_AGENT_SESSION_RESOURCE,
  attributes: {
    id: "string|required",
    issueId: "string|required",
    issueIdentifier: "string|required",
    attempt: "number|required",
    cycle: "number|required",
    provider: "string|required",
    role: "string|required",
    updatedAt: "datetime|required",
    session: "json|required",
  },
  partitions: {
    byIssueId: { fields: { issueId: "string" } },
    byIssueAttempt: { fields: { issueId: "string", attempt: "number" } },
    byProviderRole: { fields: { provider: "string", role: "string" } },
  },
  asyncPartitions: true,
  behavior: "body-overflow",
  paranoid: false,
  timestamps: false,
  api: {
    auth: false,
    methods: ["GET", "HEAD", "OPTIONS"],
    description: "Agent session snapshots per attempt",
  },
};
