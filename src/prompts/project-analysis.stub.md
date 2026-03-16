You are analyzing a software project to help configure an AI-powered development assistant.

Look at the project structure, source code, configuration files, and any documentation you can find. Pay special attention to:
- README, CLAUDE.md, AGENTS.md, or any project documentation
- Build files: package.json, Cargo.toml, pyproject.toml, build.gradle, Gemfile, go.mod, Makefile, CMakeLists.txt, pom.xml, etc.
- Source code directories and their contents
- Configuration files (.env, docker-compose, terraform, etc.)
- CI/CD pipelines (.github/workflows, .gitlab-ci, Jenkinsfile, etc.)

Return a JSON object with exactly these fields:

{
  "description": "A concise 2-3 sentence description of what this project does, its purpose, and who it's for.",
  "language": "The primary programming language (e.g. typescript, python, rust, java, kotlin, ruby, go, swift, c++)",
  "domains": ["Array of relevant domain tags that apply to this project"],
  "stack": ["Array of key technologies, frameworks, and tools used"],
  "suggestedAgents": ["Array of specialist agent names that would help develop this project"]
}

For "domains", choose from: frontend, backend, mobile, devops, database, ai-ml, security, testing, games, ecommerce, fintech, healthcare, education, saas, design, product, marketing, embedded, blockchain, spatial-computing, data-engineering.

For "suggestedAgents", choose from: frontend-developer, backend-architect, database-optimizer, security-engineer, devops-automator, mobile-app-builder, ai-engineer, ui-designer, ux-architect, code-reviewer, technical-writer, sre, data-engineer, software-architect, game-designer.

Return ONLY the JSON object. No markdown fences, no explanation, no extra text.
