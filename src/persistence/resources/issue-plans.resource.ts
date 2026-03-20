import { S3DB_ISSUE_PLAN_RESOURCE } from "../../concerns/constants.ts";

export default {
  name: S3DB_ISSUE_PLAN_RESOURCE,
  attributes: {
    id: "string|required",
    plan: "json|optional",
    planHistory: "json|optional",
    planVersion: "number|required",
  },
  behavior: "body-overflow",
  paranoid: false,
  timestamps: true,
};
