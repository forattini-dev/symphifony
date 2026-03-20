import { S3DB_AGENT_PIPELINE_RESOURCE } from "../../concerns/constants.ts";

export default {
  name: S3DB_AGENT_PIPELINE_RESOURCE,
  attributes: {
    id: "string|required",
    issueId: "string|required",
    issueIdentifier: "string|required",
    attempt: "number|required",
    updatedAt: "datetime|required",
    pipeline: "json|required",
  },
  partitions: {
    byIssueId: { fields: { issueId: "string" } },
    byIssueAttempt: { fields: { issueId: "string", attempt: "number" } },
  },
  asyncPartitions: true,
  behavior: "body-overflow",
  paranoid: false,
  timestamps: false,
  api: {
    auth: false,
    methods: ["GET", "HEAD", "OPTIONS"],
    description: "Agent pipeline snapshots per attempt",
  },
};
