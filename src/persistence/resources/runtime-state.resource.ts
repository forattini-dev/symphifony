import { S3DB_RUNTIME_RESOURCE } from "../../concerns/constants.ts";

export default {
  name: S3DB_RUNTIME_RESOURCE,
  attributes: {
    id: "string|required",
    schemaVersion: "number|required",
    trackerKind: "string|required",
    runtimeTag: "string|optional",
    updatedAt: "datetime|required",
    state: "json|required",
  },
  behavior: "body-overflow",
  paranoid: false,
  timestamps: false,
  api: {
    auth: false,
    methods: ["GET", "HEAD", "OPTIONS"],
    description: "Runtime state snapshots",
  },
};
