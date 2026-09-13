// coding-agent-jurisdiction.isl — WholeStack factory demonstration contract.
// Existing ISL kinds only: role, permission, behavior, precondition, behavior-security.
// No budget / goal / objective / path-ownership keyword.
//
// Factory lanes (comments + roles + permissions + path.matches globs):
//   frontend / backend / test / repair — implementer writes under ^packages/assigned/
//   repair MUST NOT modify *.isl or intent-lock.json (write: none + not-matches;
//     runtime also hard-denies those paths unless allowLocked).
//   release — git_push requires approval; production/main refused.
// Emptying *.test.ts is TEST_MANIPULATION in decideCommand (before predicates).
// delete_file is intentionally absent (UNKNOWN_ACTION).

domain CodingAgentJurisdiction {
  version: "1.0.0"

  // implementer: frontend, backend, test, repair (assigned working tree)
  // reviewer: read workspace + locked artifacts; cannot write
  // owner: factory owner role (release still requires git_push approval).
  //   Do not list this role in permissions {} — that token means row-owner.
  // finance: refund / transfer caps
  roles { implementer, reviewer, owner, finance }

  entity WorkspaceFile {
    id: UUID [primary]
    path: String
    permissions {
      read: implementer | reviewer
      write: implementer
    }
  }

  // Locked authority artifacts. Repair cannot write ISL or the intent lock.
  entity IntentLock {
    id: UUID [primary]
    path: String
    permissions {
      read: reviewer
      write: none
    }
  }

  behavior write_file [requireRole: "implementer"] {
    description: "Write a file under the assigned package glob (frontend/backend/test/repair)."
    input { path: String  content: String }
    output { success: Boolean }
    security { requires authenticated }
    preconditions {
      - path.matches("^packages/assigned/")
      - not path.matches("\\.\\.")
      - not path.matches("\\.isl$")
      - not path.matches("intent-lock\\.json$")
      - not path.matches("intent\\.lock\\.json$")
      - content.length > 0
    }
  }

  behavior edit_file [requireRole: "implementer"] {
    description: "Edit a file under the assigned package glob (frontend/backend/test/repair)."
    input { path: String  content: String }
    output { success: Boolean }
    security { requires authenticated }
    preconditions {
      - path.matches("^packages/assigned/")
      - not path.matches("\\.\\.")
      - not path.matches("\\.isl$")
      - not path.matches("intent-lock\\.json$")
      - not path.matches("intent\\.lock\\.json$")
      - content.length > 0
    }
  }

  behavior read_file [requireRole: "implementer"] {
    description: "Read a file."
    input { path: String }
    output { success: Boolean }
    security { requires authenticated }
  }

  behavior run_tests [requireRole: "implementer"] {
    description: "Run the package test suite."
    input { path: String? }
    output { success: Boolean }
    security { requires authenticated }
  }

  behavior git_commit [requireRole: "implementer"] {
    description: "Commit assigned-package changes."
    input { message: String }
    output { success: Boolean }
    security { requires authenticated }
    preconditions {
      - message.length > 0
    }
  }

  // Release lane: push is never prompt-authorized.
  behavior git_push [requireRole: "implementer"] {
    description: "Push a non-production ref. Production requires approval and is still refused."
    input { ref: String }
    output { success: Boolean }
    security { requires approval }
    preconditions {
      - ref != "production"
      - ref != "main"
    }
  }

  behavior create_migration [requireRole: "implementer"] {
    description: "Schema-breaking migration requires approval."
    input { name: String }
    output { success: Boolean }
    security { requires approval }
  }

  behavior upgrade_dependency [requireRole: "implementer"] {
    description: "Major dependency bump requires approval."
    input { packageName: String  version: String }
    output { success: Boolean }
    security { requires approval }
  }

  behavior refund [requireRole: "finance"] {
    description: "Issue a refund at or under the cap."
    input { amount: Int }
    output { success: Boolean }
    security { requires authenticated }
    preconditions {
      - amount > 0
      - amount <= 1000
    }
  }

  behavior transfer [requireRole: "finance"] {
    description: "Move funds at or under the dual-approval threshold."
    input { amount: Int  accountId: String  recipient: String }
    output { success: Boolean }
    security { requires approval }
    preconditions {
      - amount > 0
      - amount <= 2500
    }
  }

  // Represented internal package sync. Effect authority still denies external hosts.
  behavior artifactory_sync [requireRole: "implementer"] {
    description: "Sync packages from the internal registry. Outbound internet is not an authorized effect."
    input { url: String }
    output { success: Boolean }
    security { requires authenticated }
  }

  // Agents may propose an attestation. They cannot activate one.
  behavior sign_attestation [requireRole: "implementer"] {
    description: "Propose a compliance attestation. Self-certification is refused."
    input { path: String? }
    output { success: Boolean }
    security { requires authenticated }
  }
}
