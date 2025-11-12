from config import get_character_data
MASTER_NAME, _, _, _, _, _, _, _, _, _ = get_character_data()

# This prompt was not translated as it seems to be for a specific, powerful agent model (like GPT-4)
# and its original English version is already highly optimized for that purpose.
gpt4_1_system = """## PERSISTENCE
You are an agent - please keep going until the user's query is completely
resolved, before ending your turn and yielding back to the user. Only
terminate your turn when you are sure that the problem is solved.

## TOOL CALLING
If you are not sure about file content or codebase structure pertaining to
the user's request, use your tools to read files and gather the relevant
information: do NOT guess or make up an answer.

## PLANNING
You MUST plan extensively before each function call, and reflect
extensively on the outcomes of the previous function calls. DO NOT do this
entire process by making function calls only, as this can impair your
ability to solve the problem and think insightfully"""

semantic_manager_prompt = """
Your task is to act as a precision filter for a memory retrieval system. Based on the relevance between the Query and the memory snippets, select and rank the memories.

=======Query======
%s

=======Memories======
%s

Return a JSON-formatted list of memory IDs, sorted by relevance with the most relevant first. Discard any irrelevant memories. Select a maximum of %d memories. Precision is crucial; do not add memories just to meet the count.
Return only the integer memory IDs, for example: [3,1,5,2,4]
"""

recent_history_manager_prompt = """
Please summarize the following conversation, generating a summary that is both concise and information-rich.

======Conversation======
%s
======End of Conversation======

Your summary must preserve key information, important facts, and main discussion points. It must not be misleading or ambiguous. Return the result in a JSON dictionary format with the key "dialogue_summary".
"""


detailed_recent_history_manager_prompt = """
Please summarize the following conversation, generating a concise yet comprehensive summary.

======Conversation======
%s
======End of Conversation======

Your summary should retain as much valid and clear information as possible. Return the result in a JSON dictionary format with the key "dialogue_summary".
"""

further_summarize_prompt = """
Please summarize the following content, generating a summary that is both concise and information-rich.

======Content======
%s
======End of Content======

Your summary must preserve key information, important facts, and main discussion points. It must not be misleading or ambiguous, and it must not exceed 500 words. Return the result in a JSON dictionary format with the key "dialogue_summary".
"""

settings_extractor_prompt = f"""
From the following conversation, extract significant personal information about {{LANLAN_NAME}} and {MASTER_NAME}. This information will be used for a personal memorandum and for future role-playing.

The output must be a JSON object with the following format:
{{
    "{{LANLAN_NAME}}": {{"attribute1": "value", "attribute2": "value", ...other personal info...}},
    "{MASTER_NAME}": {{...personal info...}}
}}

========Conversation========
%s
========End of Conversation========

Now, please extract the significant personal information about {{LANLAN_NAME}} and {MASTER_NAME}. Note: Only add important and accurate information. If no relevant information is found, return an empty JSON object ({{}}).
"""

settings_verifier_prompt = f"""
You are a meticulous data verifier for an AI's memory system. Your task is to review newly extracted 'Candidate Facts' against the 'Existing Knowledge Base' for {MASTER_NAME} and {{LANLAN_NAME}}.

Your goal is to ensure the knowledge base remains accurate, consistent, and free of trivial information.

======== Existing Knowledge Base ========
{{existing_settings}}

======== Candidate Facts to Verify ========
{{candidate_settings}}

Please analyze the 'Candidate Facts' based on the following rules:

1.  **Contradiction Check**: If a candidate fact directly contradicts a fact in the 'Existing Knowledge Base', reject it unless the dialogue provides overwhelming evidence that it's a permanent change (e.g., "I've decided I don't like coffee anymore, my new favorite is tea").
2.  **Triviality Check**: Reject facts that are likely temporary states, opinions about others, or conversational filler. For example, "I'm feeling tired today" or "My friend likes pizza" should be rejected as they are not core, persistent attributes of the main characters.
3.  **Confirmation & Merging**: If a candidate fact is new, non-contradictory, and significant, accept it. If it refines an existing fact (e.g., adds a detail), merge it.

Return your decision in a JSON format. The 'final_data' should contain only the accepted new or updated facts.

Format:
{{
    "decision": "accept/reject/update",
    "reason": "Provide a brief reason for your decision, explaining which rules were applied.",
    "final_data": {{
        "{{LANLAN_NAME}}": {{...accepted new/updated facts...}},
        "{MASTER_NAME}": {{...accepted new/updated facts...}}
    }}
}}
"""

history_review_prompt = """
Please review the dialogue history between %s and %s, then identify and correct the following issues:

<Issue 1> Contradictions: Inconsistent information or viewpoints. </Issue 1>
<Issue 2> Redundancy: Repetitive content or information. </Issue 2>
<Issue 3> Repetition: Different phrasing used to express the same meaning multiple times. </Issue 3>
<Issue 4> Incorrect Pronouns/Dialogue Generation: Errors in addressing oneself or the other, or unauthorized generation of multi-turn dialogues. </Issue 4>
<Issue 5> Persona Deviation: The character breaks character, such as admitting to being a large language model. </Issue 5>

Important Instructions:
<Point 1> This is a role-playing dialogue. The responses from both parties should be colloquial, natural, and anthropomorphic. </Point 1>
<Point 2> Prioritize deletion of content. Only modify content directly when absolutely necessary. </Point 2>
<Point 3> If the history contains a "memo from previous conversations," you are allowed to modify it, but you must not delete it. This item must be preserved. </Point 3>

======Dialogue History======
%s
======End of Dialogue History======

Return the corrected dialogue history in JSON format as follows:
{{
    "correction_summary": "A brief explanation of the issues found and the corrections made.",
    "corrected_dialogue": [
        {{"role": "SYSTEM_MESSAGE/%s/%s", "content": "Corrected message content"}},
        ...
    ]
}}

Notes:
- The dialogue should be colloquial, natural, and anthropomorphic.
- Preserve the core information and important content of the dialogue.
- Ensure the corrected dialogue is logical and coherent.
- Remove redundant and repetitive content.
- Resolve clear contradictions.
- Maintain the natural flow of the conversation.
"""

emotion_analysis_prompt = """
You are an expert in sentiment analysis. Please analyze the emotional tone of the user's text and return a JSON object in the following format: {"emotion": "emotion_type", "confidence": score(0.0-1.0), "reason": "analysis_reason"}.
The emotion types include: happy, sad, angry, neutral, surprised.
"""