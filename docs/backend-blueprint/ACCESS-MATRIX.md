# Access-control matrix

Legend: R read, C create, U update, D delete/hide, — denied, S service-only, A scoped admin. Every user action additionally requires active account and no applicable block.

| Resource | Owner | Visible user | Member/participant | Moderator | Support | Worker |
|---|---:|---:|---:|---:|---:|---:|
| private profile/settings | R/U | — | — | case-limited metadata | limited metadata | S |
| public profile | R/U | R by visibility | R | R if case | R minimal | S |
| exact location | R/U | — | — | — by default | — | S query only |
| rounded distance | R | R from discover response | R | case metadata | — | S |
| post/recipe | C/R/U/D | R/V; interact | R/V | R/hide if case | — | S |
| comments/likes/saves | own C/R/U/D | R/V/create | R/V | case action | — | S |
| conversation metadata | own member state | — | R/U own state | case metadata | minimal | S |
| message content | own sent | — | R/send | only reported evidence + approval | — | S delivery only |
| message media | owner | — | signed R | reported evidence | — | S process |
| workout session | creator C/R/U | — | R/respond | case metadata/action | minimal | S |
| invitation | inviter R/revoke | invitee R/respond | participant R | case | — | S |
| notification | R/U | — | — | — | — | S create |
| device token | register/revoke own | — | — | — | — | S send/revoke |
| report | C/R status | — | — | assigned R/U | status only | S |
| audit log | — | — | — | own-action subset | — | append; auditor R |
| account deletion/export | request/status | — | — | legal hold only | assist status | S process |

Admin access is not a generic RLS bypass; use audited server endpoints with case/role predicates and time-bound emergency grants.
