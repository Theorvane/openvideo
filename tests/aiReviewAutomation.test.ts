import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const readWorkflow = (name: string) =>
  readFileSync(resolve(process.cwd(), ".github", "workflows", name), "utf8")

describe("AI pull request automation", () => {
  it("requests the designated reviewer without checking out untrusted code", () => {
    const workflow = readWorkflow("ai-review-request.yml")

    expect(workflow).toContain("pull_request_target:")
    expect(workflow).toContain("types: [opened, reopened, ready_for_review, synchronize]")
    expect(workflow).toContain("branches: [dev, main]")
    expect(workflow).toContain("pull-requests: write")
    expect(workflow).toContain("issues: write")
    expect(workflow).toContain("reviewers[]=sjungwon03-ai")
    expect(workflow).toContain("PR_AUTHOR: ${{ github.event.pull_request.user.login }}")
    expect(workflow).toContain("assignees[]=${PR_AUTHOR}")
    expect(workflow).toContain("labels[]=ai-review-requested")
    expect(workflow).not.toContain("actions/checkout")
  })

  it("only enables the target branch's merge method after current-HEAD approval", () => {
    const workflow = readWorkflow("ai-approved-automerge.yml")

    expect(workflow).toContain("pull_request_review:")
    expect(workflow).toContain("types: [submitted]")
    expect(workflow).toContain("github.event.review.state == 'approved'")
    expect(workflow).toContain("github.event.review.user.login == 'sjungwon03-ai'")
    expect(workflow).toContain("github.event.review.commit_id == github.event.pull_request.head.sha")
    expect(workflow).toContain("github.event.pull_request.base.ref == 'dev'")
    expect(workflow).toContain("github.event.pull_request.base.ref == 'main'")
    expect(workflow).toContain("labels[]=ai-approved")
    expect(workflow).toContain("labels/ai-review-requested")
    expect(workflow).toContain('gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY"')
    expect(workflow).toContain('github.event.pull_request.base.ref }}" = "main"')
    expect(workflow).toContain('gh pr merge "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --auto --merge --delete-branch')
    expect(workflow).toContain('gh pr merge "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --auto --squash --delete-branch')
  })
})
