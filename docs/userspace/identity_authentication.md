---
title: Identity and Authentication Service
section: userspace
status: Implemented
updated: 2026-05-24
order: 5
excerpt: userd databases, password hashing, login authentication, account resolution, and password changes.
tags: userd, authentication, passwd, shadow, uid
---

## Design Boundary

`userd` owns account records and password verification in userspace. The kernel carries UID and GID on processes and enforces file ownership and capability rules, but it does not parse account database files or authenticate password text.

```text
login / su / passwd / ps / prompt
            |
            | structured IPC requests
            v
          userd
       /     |      \
/etc/passwd /etc/group /etc/shadow
            |
            | resolved uid/gid or authenticated account
            v
kernel process identity and filesystem enforcement
```

## Account Databases

At service startup, `userd` ensures that each account database exists, loads valid records into bounded in-memory tables, and only then marks itself ready.

| Path | Format | Default Mode and Use |
| --- | --- | --- |
| `/etc/passwd` | `<name>:<uid>:<gid>:<home>` | Public identity and home lookup |
| `/etc/group` | `<name>:<gid>:<member1,member2,...>` | Public group lookup |
| `/etc/shadow` | `<name>:pbkdf2-sha256:<iterations>:<salt hex>:<hash hex>` | Password verifier data, forced to mode `0600` |

The current in-memory limit is eight users and eight groups, with a 512-byte shared database loading buffer.

## Initial Database Contents

| Account | UID | GID | Home |
| --- | ---: | ---: | --- |
| `root` | `0` | `0` | `/` |
| `rkc` | `1000` | `1000` | `/home/rkc` |

| Group | GID | Initial Members |
| --- | ---: | --- |
| `root` | `0` | `root` |
| `rkc` | `1000` | `rkc` |

Default password verifier records are created for the two initial accounts when no shadow database exists. Plaintext passwords are never stored in `/etc/passwd`.

## Password Storage

Passwords are represented by PBKDF2-HMAC-SHA256 records:

| Parameter | Current Value |
| --- | ---: |
| Algorithm name | `pbkdf2-sha256` |
| Salt size | 16 bytes |
| Derived hash size | 32 bytes |
| Default iteration count | 128 |

New password salts are supplied through the entropy syscall. Verification derives a candidate hash and compares the result in constant time before the temporary computed hash is zeroed.

The iteration value is intentionally stored with each shadow record, allowing a later password update policy to increase the work factor without making old records unparsable.

## IPC Operations

| Request | Result |
| --- | --- |
| Resolve username | Public passwd record |
| Resolve UID | Public passwd record |
| Resolve group name | Public group record |
| Resolve GID | Public group record |
| Authenticate username and password | Public passwd record only on successful verification |
| Set password | Success/failure after generating and persisting a new shadow hash |

The kernel stamps request UID and GID onto IPC packets. Password mutation is accepted only when the caller is root or the target UID equals the request sender UID.

## Clients

| Client | Why It Uses `userd` |
| --- | --- |
| `login` | Verify credentials and obtain identity/home for the new shell |
| Shell `su` | Authenticate before changing the current interactive identity |
| `passwd` | Resolve the target account and request a confirmed password update |
| `ps`, `id`, prompt rendering | Translate numeric UID/GID values into names |

This service boundary keeps account storage changeable without expanding the trusted kernel parser surface.

## Actual Account File and Identity Output

The following actual execution result shows account files after `userd` initialized the database. Public account databases are readable while password verifiers are stored in a mode-`0600` shadow file.

```text
root@Rk-C:/$ ls -l /etc
-rw-r--r--      root:root       79 bytes        os-release
-rw-r--r--      root:root       35 bytes        passwd
-rw-------      root:root       241 bytes       shadow
-rw-r--r--      root:root       25 bytes        group
-rw-r--r--      root:root       18 bytes        resolve.conf
-rw-r--r--      root:root       55 bytes        interface.conf

root@Rk-C:/$ cat /etc/passwd
root:0:0:/
rkc:1000:1000:/home/rkc

root@Rk-C:/$ id
uid=0(root) gid=0(root)
root@Rk-C:/$
```
