import { defineRailway, github, project, service } from "railway/iac";

// Railway Infrastructure as Code for the croton-project service. Replaces the
// old railway.json (Config as Code, read by Railway only until 2026-12-01).
// Railway does not read this file on deploy: it takes effect only through
// `railway config plan` / `railway config apply`. See
// docs/guide/02-setup-and-deployment.md.

// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "croton-project";

export default defineRailway(() => {
  const crotonProject = service("croton-project", {
    source: github("mkozmelj/croton-project", { branch: "main", checkSuites: false }),
    build: { buildCommand: "npm run build", buildEnvironment: "V3", builder: "RAILPACK" },
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 30,
    // `railway config migrate` drops these two railway.json settings; carried over by hand.
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
    replicas: { "europe-west4-drams3a": 1 },
  });

  // Variables stay owned by Railway (set via the dashboard or `railway variables`),
  // so secrets never have to appear here.
  return project("joyful-beauty", {
    variables: { managed: false },
    resources: [crotonProject],
  });
});
