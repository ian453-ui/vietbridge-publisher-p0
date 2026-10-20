# Sanitized V1 production reference

This directory is a public **reference derivative** of the independently running V1 release identified in `manifest.json`. It contains 52 source files and one startup wrapper. Each manifest entry identifies whether its bytes are unchanged or sanitized and provides the hash of the public copy. Original production hashes are intentionally kept only on the Mac.

Sanitization replaces client article/workspace identifiers, account ID and display name, and absolute user-specific paths with explicit placeholders. Client-specific module names in the public copy are generic. Do not deploy or execute this snapshot as-is. The startup wrapper also depends on private runtime adapters omitted from this public reference. Restore real bindings only through the existing private deployment configuration after separate review.

This directory contains no environment file, credentials, cookies, browser profile, database, customer content, or platform readback data. It does not grant publishing capability or prove live platform behavior.
