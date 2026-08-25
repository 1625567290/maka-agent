<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# WorkHub domain language

WorkHub gives users one persistent conversational place to ask, clarify, continue,
create, and inspect work. It is backed by one stable Coordination Session per
Runtime Host while concrete execution remains authoritative in ordinary Sessions.

This document names the approved target architecture. The current R2.4
implementation is a transitional deterministic router and does not yet create the
Coordination Session described below.

## Terms

**Session**: The existing transcript, execution-boundary, permission, interaction,
and recovery substrate. A Session owns only the conversation or execution admitted
to that Session.

**Coordination Session**: A special Session role used by WorkHub. Each Runtime Host
has at most one stable Coordination Session. It owns WorkHub user messages, ordinary
Q&A, clarification, coordination decisions, delegation references, and coordination
summaries. It is hidden from the ordinary Session list and never routes to itself.

**Ordinary Session**: A Session that owns concrete work execution, including its
project/filesystem scope, model and permissions, root-Turn admission, tools,
artifacts, recovery, lifecycle, and authoritative execution transcript.

**Work**: User-facing continuity around a goal. Whether Work is 1:1 with Session,
1:N over Sessions, or an independent durable entity is deliberately unresolved.

**WorkHub**: The unified conversational entry and coordination surface backed by
the active Runtime Host's Coordination Session. It may answer locally, clarify,
delegate to an existing ordinary Session, or create a new ordinary Session.

**Session projection**: A rebuildable view derived from Session facts for display and routing. It can be discarded and recreated without losing work.

**Disposition**: The coordination outcome for one WorkHub input:
`answer_here`, `delegate_existing`, `create_new`, or `clarify`.

**Delegation**: A reference from a Coordination Turn to a target ordinary Session
and Turn. Delegation links the two authoritative transcripts; it does not copy the
target execution transcript into WorkHub.

**Action Gate**: The deterministic Runtime boundary that validates a proposed
disposition, target, creation, Stop, confirmation, tools, and permissions. A model
or routing policy may propose an action but cannot authorize it.

**Route correction**: A user's decision that an input belongs to a different
existing Session. R2.4 retains only bounded inference memory for later target
resolution. Correction precedence follows user submission order, not asynchronous
completion order, and it never replaces either Session's transcript authority.

**R2.4**: The deterministic context-continuity routing baseline. It remains useful
as an experiment baseline or target resolver behind WorkHub's coordination layer;
it is not the final architecture or authority boundary of WorkHub.

_Avoid_: copied execution transcripts, self-routing, a second Session/WorkHub
storage substrate, or treating model/routing output as execution authority.
