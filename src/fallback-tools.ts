// Bundled tool lists for well-known servers whose tool list is often never
// learned on an install, so ranking has something to rank them on.
//
// Why: find_tool and dispatch rank tools from cached tool lists only. A
// server whose startup pre-warm fails -- in practice the docker-image
// servers below, when docker is not running or a credential is missing --
// never gets a list, so find_tool cannot see it at all and dispatch ranks it
// on its name and one-line description alone. On one real 21-server install
// "create a github issue" made find_tool answer tailscale_create_key.
//
// Scope, deliberately narrow:
//   * used ONLY when the server has no real list: no live connection, no
//     list learned in this or an earlier session (an EMPTY learned list is a
//     real observation and also wins), and no curated toolCache on the entry.
//     The first successful load replaces it for good (see rankableFor in
//     server.ts, the one reader).
//   * keyed by the server's IDENTITY -- the docker image or the binary its
//     command runs -- never by the namespace the user chose, so a server
//     someone named "github" that runs something else gets nothing.
//   * names plus the first sentence of each description, nothing else. No
//     input schemas: these lists are never used to validate or build a call,
//     and they never create a tools/list entry or a route.
//
// Every list was read from the upstream source, not written from memory, at
// the tag named on it. Each covers the server's DEFAULT tool set (what the
// image serves with no toolset flags), since that is what a bare
// `docker run <image>` install exposes.
//
// Refresh: re-read the files named at each list for a newer tag and update
// the tag. A stale entry costs one ranking hint, never a failed call -- the
// list is replaced by the real one as soon as the server loads.

export interface FallbackTool {
  name: string;
  description: string;
}

interface FallbackEntry {
  /** Docker image repositories (no tag or digest) that run this server. */
  images: readonly string[];
  /** Binary basenames (no extension) that run this server directly. */
  binaries: readonly string[];
  tools: readonly FallbackTool[];
}

const list = (rows: ReadonlyArray<readonly [string, string]>): FallbackTool[] =>
  rows.map(([name, description]) => ({ name, description }));

// github/github-mcp-server v2.1.0 (commit 4bcdcdf8d7beee98c9448e73e257308280924cc4).
// The default toolset is context, repos, issues, pull_requests, users
// (README "default" toolset). Names are the README's per-toolset tool lists
// for those five; descriptions are from pkg/github/__toolsnaps__/<name>.snap.
// ui_get (context) is left out: its source declares it visible to MCP App
// views only, not to the model.
const GITHUB = list([
  ["get_me", "Get details of the authenticated GitHub user"],
  ["get_team_members", "Get member usernames of a specific team in an organization"],
  ["get_teams", "Get details of the teams the user is a member of"],
  ["add_issue_comment", "Add a comment and/or reaction to a specific issue or issue comment in a GitHub repository"],
  ["get_label", "Get a specific label from a repository"],
  ["issue_read", "Get information about a specific issue in a GitHub repository"],
  ["issue_write", "Create a new or update an existing issue in a GitHub repository"],
  ["list_issue_fields", "List issue fields for a repository or organization"],
  ["list_issue_types", "List supported issue types for a repository or its owner organization"],
  ["list_issues", "List issues in a GitHub repository"],
  ["search_issues", "Search issues using natural-language semantic matching"],
  ["sub_issue_write", "Add a sub-issue to a parent issue in a GitHub repository"],
  ["update_issue_comment", "Update the body of an existing issue or pull request conversation comment"],
  ["add_comment_to_pending_review", "Add review comment to the requester's latest pending pull request review"],
  ["add_reply_to_pull_request_comment", "Add a reply and/or reaction to an existing pull request comment"],
  ["create_pull_request", "Create a new pull request in a GitHub repository"],
  ["list_pull_requests", "List pull requests in a GitHub repository"],
  ["merge_pull_request", "Merge a pull request in a GitHub repository"],
  ["pull_request_read", "Get information on a specific pull request in GitHub repository"],
  ["pull_request_review_write", "Create and/or submit, delete review of a pull request"],
  [
    "search_pull_requests",
    "Search for pull requests in GitHub repositories using issues search syntax already scoped to is:pr",
  ],
  ["update_pull_request", "Update an existing pull request in a GitHub repository"],
  ["update_pull_request_branch", "Update the branch of a pull request with the latest changes from the base branch"],
  ["create_branch", "Create a new branch in a GitHub repository"],
  ["create_or_update_file", "Create or update a single file in a GitHub repository"],
  ["create_repository", "Create a new GitHub repository in your account or specified organization"],
  ["delete_file", "Delete a file from a GitHub repository"],
  ["delete_repository", "Delete a GitHub repository after the user confirms the exact owner/repository name"],
  ["fork_repository", "Fork a GitHub repository to your account or specified organization"],
  ["get_commit", "Get details for a commit from a GitHub repository"],
  ["get_file_contents", "Get the contents of a file or directory from a GitHub repository"],
  ["get_latest_release", "Get the latest release in a GitHub repository"],
  ["get_release_by_tag", "Get a specific release by its tag name in a GitHub repository"],
  ["get_tag", "Get details about a specific git tag in a GitHub repository"],
  ["list_branches", "List branches in a GitHub repository"],
  ["list_commits", "Get list of commits of a branch in a GitHub repository"],
  ["list_releases", "List releases in a GitHub repository"],
  ["list_repository_collaborators", "List collaborators of a GitHub repository"],
  ["list_tags", "List git tags in a GitHub repository"],
  ["push_files", "Push multiple files to a GitHub repository in a single commit"],
  ["search_code", "Fast and precise code search across ALL GitHub repositories using GitHub's native search engine"],
  ["search_commits", "Search for commits across GitHub repositories using GitHub's commit search syntax"],
  ["search_repositories", "Find GitHub repositories by name, description, readme, topics, or other metadata"],
  ["search_users", "Find GitHub users by username, real name, or other profile information"],
]);

// hashicorp/terraform-mcp-server v1.4.1 (commit 3781509a674482ca7e2821fab8159a25e3b29bdf).
// The default toolset is "registry" (pkg/toolsets/toolsets.go
// DefaultToolsets, tool membership in pkg/toolsets/registry.go); the other
// toolsets need a TFE token AND a --toolsets flag. Descriptions are from
// pkg/mcp-official/tools/registry/<name>.go.
const TERRAFORM = list([
  ["get_latest_module_version", "Fetches the latest version of a Terraform module from the public registry"],
  ["get_latest_provider_version", "Fetches the latest version of a Terraform provider from the public registry"],
  ["get_module_details", "Fetches up-to-date documentation on how to use a Terraform module"],
  ["get_policy_details", "Fetches up-to-date documentation for a specific policy from the Terraform registry"],
  [
    "get_provider_capabilities",
    "Get the capabilities of a Terraform provider including the types of resources, data sources, functions, guides, and other features it supports",
  ],
  ["get_provider_details", "Fetches up-to-date documentation for a specific service from a Terraform provider"],
  [
    "search_modules",
    "Resolves a Terraform module name to obtain a compatible module_id for the get_module_details tool and returns a list of matching Terraform modules",
  ],
  ["search_policies", "Searches for Terraform policies based on a query string"],
  [
    "search_provider_docs",
    "This tool retrieves a list of potential documents based on the 'service_slug' and 'provider_document_type' provided",
  ],
]);

// hashicorp/vault-mcp-server v0.2.0 (commit c67575dc4f98db37f187d62400bd70fe0211a60c).
// Every tool InitTools registers (pkg/tools/tools.go), in its order;
// descriptions are from pkg/tools/{sys,kv,pki}/<name>.go.
const VAULT = list([
  ["list_mounts", "List the available mounted secrets engines on a Vault Server"],
  ["create_mount", "Mount a new secrets engine on a specific path in Vault"],
  ["delete_mount", "Delete a mounted secret engine in Vault"],
  ["list_secrets", "List secrets in a KV mount under a specific path in Vault"],
  ["read_secret", "Read a secret from a KV mount in at a specific path in Vault"],
  ["write_secret", "Writes a secret value to a KV store in Vault using the specified path and mount"],
  ["delete_secret", "Delete a secret from a KV mount in Vault using the specified path and mount"],
  [
    "enable_pki",
    "Enable the PKI (Public Key Infrastructure) secrets engine in Vault, allowing for the issuance and management of SSL/TLS certificates",
  ],
  ["create_pki_issuer", "Create a new PKI SSL certificate issuer in Vault"],
  [
    "list_pki_issuers",
    "Get a list of PKI issuers on a specific pki mount in Vault, allowing you to see all the configured issuers for that mount",
  ],
  [
    "read_pki_issuer",
    "Read a PKI issuer details from a specific mount in Vault, allowing you to retrieve information about a specific PKI issuer",
  ],
  [
    "list_pki_roles",
    "Get a list of PKI roles which are able to issue certificates, allowing you to see all the configured roles for a specific PKI mount in Vault",
  ],
  ["read_pki_role", "Read a PKI role details from a specific mount in Vault"],
  ["create_pki_role", "Create a new PKI SSL certificate role in Vault"],
  ["delete_pki_role", "Delete a PKI SSL role in Vault"],
  [
    "issue_pki_certificate",
    "Create a new PKI SSL certificate issuer in Vault, allowing for the issuance of SSL/TLS certificates",
  ],
]);

const ENTRIES: readonly FallbackEntry[] = [
  { images: ["ghcr.io/github/github-mcp-server"], binaries: ["github-mcp-server"], tools: GITHUB },
  {
    images: ["hashicorp/terraform-mcp-server", "docker.io/hashicorp/terraform-mcp-server"],
    binaries: ["terraform-mcp-server"],
    tools: TERRAFORM,
  },
  {
    images: ["hashicorp/vault-mcp-server", "docker.io/hashicorp/vault-mcp-server"],
    binaries: ["vault-mcp-server"],
    tools: VAULT,
  },
];

/** `ghcr.io/github/github-mcp-server:v2@sha256:...` -> `ghcr.io/github/github-mcp-server`. */
function imageRepository(arg: string): string {
  const noDigest = arg.split("@")[0];
  // A tag colon comes after the last slash; a registry port colon does not.
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  return (colon > slash ? noDigest.slice(0, colon) : noDigest).toLowerCase();
}

/** `C:\tools\vault-mcp-server.exe` -> `vault-mcp-server`. */
function binaryName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/** The bundled tool list for the server this entry launches, or undefined
 *  when it is not one of the known servers. Matches a docker/podman image
 *  anywhere in the args (after `run`, past its flags) or the command's own
 *  binary name. Remote (url) entries never match: a hosted endpoint can serve
 *  a different tool set than the image. */
export function fallbackToolsFor(server: {
  command?: string;
  args?: readonly string[];
}): readonly FallbackTool[] | undefined {
  if (!server.command) return undefined;
  const bin = binaryName(server.command);
  const args = server.args ?? [];
  const containerRuntime = bin === "docker" || bin === "podman";
  for (const entry of ENTRIES) {
    if (entry.binaries.includes(bin)) return entry.tools;
    if (containerRuntime && args.some((a) => !a.startsWith("-") && entry.images.includes(imageRepository(a)))) {
      return entry.tools;
    }
  }
  return undefined;
}
