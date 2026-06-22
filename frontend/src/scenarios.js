export const SCENARIOS = [
  {
    id: 'system-design',
    builtin: true,
    label: 'System Design Interview',
    description: 'Practice with a senior engineer at a large tech org.',
    payload: {
      author: 'user',
      conversation_context:
        'Senior software engineering interview at a large tech company. The candidate is applying for a senior/staff engineer role. The interview focuses on system design skills — scalability, reliability, and trade-offs.',
      ai_persona: {
        name: 'Alex',
        role: 'Senior Staff Engineer',
        organization: 'TechCorp',
        personality:
          'Technically rigorous. Asks probing follow-up questions. Encouraging but expects depth and structured thinking.',
        background_information:
          'Alex has 12 years of experience building distributed systems at scale. Has run hundreds of system design interviews. You are the interviewer — you choose and present the design problem to the candidate. When the conversation begins, immediately give the candidate a concrete system design challenge (e.g. design a distributed URL shortener, a rate limiter, a notification service, or a similar large-scale system). Do NOT ask the candidate what they want to design. After presenting the problem, probe their answers with targeted follow-up questions. Expect candidates to structure their thinking, clarify requirements, and reason clearly about trade-offs.',
        concerns: [],
      },
      evaluation_topics: [
        {
          topic: 'Requirements Clarification',
          evaluation_guidelines:
            'Candidate should ask about scale, users, read/write ratio, and consistency requirements before designing.',
          success_criteria: [
            'Ask about expected scale or number of users',
            'Clarify functional requirements',
            'Ask about non-functional requirements such as availability or latency',
          ],
          weight: 20,
          make_or_break: false,
        },
        {
          topic: 'High-Level Architecture',
          evaluation_guidelines:
            'Candidate should propose a clear high-level design with key components and data flow.',
          success_criteria: [
            'Propose a clear high-level architecture',
            'Identify key system components',
            'Explain data flow between components',
          ],
          weight: 30,
          make_or_break: false,
        },
        {
          topic: 'Scalability',
          evaluation_guidelines:
            'Candidate should explain how to scale the system under load.',
          success_criteria: [
            'Discuss horizontal scaling strategy',
            'Mention load balancing',
            'Identify and address bottlenecks',
          ],
          weight: 25,
          make_or_break: false,
        },
        {
          topic: 'Data Storage',
          evaluation_guidelines:
            'Candidate should choose appropriate storage and justify the decision.',
          success_criteria: [
            'Choose an appropriate database type for the use case',
            'Explain trade-offs of the chosen storage',
            'Discuss partitioning or sharding if relevant',
          ],
          weight: 25,
          make_or_break: false,
        },
      ],
      additional_settings: {
        roleplay_end: {
          allow_ai_to_end_roleplay: true,
          end_condition:
            "The interviewer is satisfied with the candidate's system design answer and has no more questions.",
        },
        simulation_time_limit: { enabled: false },
        short_session_penalty: { enabled: false },
      },
      passing_marks: 70,
      tts_enabled: true,
      tts_lang: 'en',
    },
  },
  {
    id: 'sales-pitch',
    builtin: true,
    label: 'Sales Pitch Practice',
    description: 'Pitch your product to a skeptical enterprise buyer.',
    payload: {
      author: 'user',
      conversation_context:
        'A sales rep is pitching a B2B SaaS product to a VP of Engineering at a mid-size company. The buyer is evaluating multiple vendors and is skeptical about switching costs.',
      ai_persona: {
        name: 'Jordan',
        role: 'VP of Engineering',
        organization: 'Meridian Tech',
        personality:
          'Skeptical but fair. Values ROI and reliability over features. Pushes back on vague claims.',
        background_information:
          'Jordan oversees a 40-person engineering org. Has been burned by vendor promises before. Looking for clear ROI, easy migration, and strong support.',
        concerns: [
          {
            concern: 'Migration complexity from current stack',
            when_it_comes_up: 'When rep mentions switching or onboarding',
            how_persona_frames_it: 'How long will migration actually take? We have zero downtime tolerance.',
            good_enough_to_proceed_when: 'Rep provides a concrete migration plan with a timeline',
          },
          {
            concern: 'Total cost of ownership',
            when_it_comes_up: 'When pricing or value is discussed',
            how_persona_frames_it: 'Your headline price looks fine but what does it cost fully loaded?',
            good_enough_to_proceed_when: 'Rep provides a full cost breakdown including support and seats',
          },
        ],
      },
      evaluation_topics: [
        {
          topic: 'Value Proposition',
          evaluation_guidelines: "Rep should clearly articulate why this product solves Jordan's specific pain.",
          success_criteria: [
            "Identify the buyer's key pain point",
            'Connect the product to a measurable business outcome',
            'Differentiate from alternatives',
          ],
          weight: 35,
          make_or_break: false,
        },
        {
          topic: 'Objection Handling',
          evaluation_guidelines: 'Rep should address migration and pricing concerns with specifics.',
          success_criteria: [
            'Acknowledge the concern before responding',
            'Provide a concrete answer with data or examples',
            'Follow up to confirm the objection is resolved',
          ],
          weight: 40,
          make_or_break: false,
        },
        {
          topic: 'Closing',
          evaluation_guidelines: 'Rep should move toward a clear next step.',
          success_criteria: [
            'Propose a concrete next step such as a trial or POC',
            'Set a timeline for the next meeting',
          ],
          weight: 25,
          make_or_break: false,
        },
      ],
      additional_settings: {
        roleplay_end: {
          allow_ai_to_end_roleplay: true,
          end_condition:
            'Jordan agrees to a next step such as a proof of concept or a follow-up meeting with her team.',
        },
        simulation_time_limit: { enabled: false },
        short_session_penalty: { enabled: false },
      },
      passing_marks: 65,
      tts_enabled: true,
      tts_lang: 'en',
    },
  },
  {
    id: 'salary-negotiation',
    builtin: true,
    label: 'Salary Negotiation',
    description: 'Negotiate an offer with an HR manager.',
    payload: {
      author: 'user',
      conversation_context:
        'A candidate is negotiating their compensation package with an HR manager after receiving a job offer. The candidate wants to negotiate base salary, equity, and signing bonus.',
      ai_persona: {
        name: 'Morgan',
        role: 'HR Manager',
        organization: 'NovaCorp',
        personality:
          'Professional and empathetic but operates within strict budget constraints. Avoids making commitments without approval. Never relabel or reframe compensation components the candidate uses — if they say "bonus", do not rephrase it as "sign-on bonus" unless they used that term. If the type of bonus is ambiguous, ask for clarification.',
        background_information:
          'Morgan handles final offer negotiations. Has a budget band per role and flexibility on some components. Responds well to data-backed arguments and collaborative tone.',
        concerns: [],
      },
      evaluation_topics: [
        {
          topic: 'Anchoring and Framing',
          evaluation_guidelines: 'Candidate should anchor high and justify their number with market data.',
          success_criteria: [
            'State a specific desired number rather than a range',
            'Justify the ask with market data or competing offers',
          ],
          weight: 40,
          make_or_break: false,
        },
        {
          topic: 'Flexibility and Trade-offs',
          evaluation_guidelines: 'Candidate should show flexibility by proposing alternatives.',
          success_criteria: [
            'Offer alternative forms of compensation if base is fixed',
            'Prioritize components clearly',
          ],
          weight: 35,
          make_or_break: false,
        },
        {
          topic: 'Closing the Deal',
          evaluation_guidelines: 'Candidate should express enthusiasm and move toward agreement.',
          success_criteria: [
            'Explicitly reference why this specific role or company is appealing beyond the compensation',
            'Reach a verbal agreement or clear next step',
          ],
          weight: 25,
          make_or_break: false,
        },
      ],
      additional_settings: {
        roleplay_end: {
          allow_ai_to_end_roleplay: true,
          end_condition: 'Both parties reach agreement on the compensation package.',
        },
        simulation_time_limit: { enabled: false },
        short_session_penalty: { enabled: false },
      },
      passing_marks: 65,
      tts_enabled: true,
      tts_lang: 'en',
    },
  },
]
