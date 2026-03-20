import { S3DB_SETTINGS_RESOURCE } from "../../concerns/constants.ts";

export default {
  name: S3DB_SETTINGS_RESOURCE,
  attributes: {
    id: "string|required",
    scope: "string|required",
    value: "json|required",
    source: "string|required",
    updatedAt: "datetime|required",
  },
  partitions: {
    byScope: { fields: { scope: "string" } },
  },
  asyncPartitions: true,
  behavior: "body-overflow",
  paranoid: false,
  timestamps: false,
  api: {
    enabled: false,
  },
};
